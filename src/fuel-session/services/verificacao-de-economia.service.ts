import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { interpretarTotalEconomizado } from 'src/economia/domain/total-economizado';
import { EconomiaService } from 'src/economia/services/economia.service';
import {
  DadosDaChecagem,
  JOB_CHECAR_ECONOMIA,
  decidirChecagem,
  jobIdDaChecagem,
  mensagemDeEconomia,
  numeroDaChecagem,
} from 'src/fuel-session/domain/verificacao-de-economia';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { baseDoJob } from 'src/queue/job-envelope';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { FUEL_ECONOMY_QUEUE } from 'src/queue/queue.module';

export type ResultadoDaVerificacao =
  | { skipped: true; reason: 'session_not_found' }
  | { skipped: true; reason: 'already_processed'; status?: string }
  | {
      processed: true;
      diferenca: number;
      novoTotal: number;
      /** `falhou`: o Expo recusou; `sem_token`: usuário sem push registrado. */
      push: 'enviado' | 'sem_token' | 'falhou';
    }
  | {
      processed: false;
      reason: 'sem_variacao';
      checagem: number;
      proximaChecagem: number;
      atrasoMs: number;
    }
  | {
      processed: false;
      reason: 'teto_de_checagens';
      checagem: number;
      /** `false`: outra execução já tinha encerrado a sessão. */
      expirada: boolean;
    };

export type ExpiracaoAposFalha = 'EXPIRADA' | 'JA_ENCERRADA' | 'FALHOU';

/** Tentativas de expirar a sessão quando o job morre, e a pausa entre elas. */
const TENTATIVAS_DE_EXPIRACAO = 3;
const PAUSA_ENTRE_TENTATIVAS_MS = 150;

const pausa = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Uma checagem da verificação de economia (o trabalho do job
 * `check-fuel-economy`): lê o total atual no Clubgas e conclui a sessão,
 * agenda a próxima checagem ou expira a sessão.
 *
 * Só erro de verdade sai daqui como exceção (Clubgas fora, banco, fila) e
 * segue o retry da fila. "Sem variação ainda" é resultado normal.
 */
@Injectable()
export class VerificacaoDeEconomiaService {
  private readonly logger = new Logger(VerificacaoDeEconomiaService.name);

  constructor(
    private readonly sessoes: FuelSessionRepository,
    private readonly economia: EconomiaService,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly produtor: ProdutorDeFilas,
  ) {}

  /**
   * @param dados payload do job (com o envelope, de onde sai a base)
   * @param tentativasJaFeitas `job.attemptsMade` — só conta para job antigo,
   *   sem o contador de checagens no payload
   */
  async verificar(
    dados: DadosDaChecagem,
    tentativasJaFeitas: number,
  ): Promise<ResultadoDaVerificacao> {
    const { fuelSessionId } = dados;
    const checagem = numeroDaChecagem(dados, tentativasJaFeitas);

    const sessao = await this.sessoes.buscarPorId(fuelSessionId);
    if (!sessao) {
      this.logger.warn(
        `[FUEL] FuelSession ${fuelSessionId} não encontrada — ignorando`,
      );
      return { skipped: true, reason: 'session_not_found' };
    }

    // Idempotência: entrega repetida do job de uma sessão já encerrada.
    if (sessao.status !== 'PENDING') {
      return {
        skipped: true,
        reason: 'already_processed',
        status: sessao.status,
      };
    }

    const resposta = (await this.economia.consultarTotalEconomizado(
      sessao.userId,
      'JOB_ECONOMIA',
    )) as { totalEconomizado?: unknown; errors?: unknown[] } | null;

    if (resposta?.errors?.length) {
      throw new Error(
        `Erro na API externa de economia: ${JSON.stringify(resposta.errors)}`,
      );
    }

    const valorAtual = interpretarTotalEconomizado(resposta?.totalEconomizado);
    if (valorAtual === null) {
      throw new Error(
        `Valor inválido retornado pela API externa: "${String(resposta?.totalEconomizado)}"`,
      );
    }

    const decisao = decidirChecagem({
      valorAntes: sessao.valorAntes,
      valorAtual,
      checagem,
    });

    switch (decisao.tipo) {
      case 'ABASTECEU':
        return this.concluir(
          sessao.id,
          sessao.userId,
          decisao.diferenca,
          decisao.novoTotal,
        );

      case 'REAGENDAR':
        // `jobId` por sessão e checagem: se este job repetir depois de já
        // ter agendado a próxima, o segundo `add` é ignorado.
        await this.produtor.enfileirar(
          FUEL_ECONOMY_QUEUE,
          JOB_CHECAR_ECONOMIA,
          { fuelSessionId, checagem: decisao.proximaChecagem },
          {
            base: baseDoJob(dados),
            atrasoMs: decisao.atrasoMs,
            jobId: jobIdDaChecagem(fuelSessionId, decisao.proximaChecagem),
          },
        );
        return {
          processed: false,
          reason: 'sem_variacao',
          checagem,
          proximaChecagem: decisao.proximaChecagem,
          atrasoMs: decisao.atrasoMs,
        };

      case 'EXPIRAR': {
        const expirada = await this.sessoes.expirar(fuelSessionId);
        this.logger.log(
          `[FUEL] FuelSession ${fuelSessionId} sem variação após ${checagem} checagem(ns) — ${expirada ? 'expirada' : 'já estava encerrada'}`,
        );
        return {
          processed: false,
          reason: 'teto_de_checagens',
          checagem,
          expirada,
        };
      }
    }
  }

  /**
   * Chamado quando o job morre (tentativas esgotadas ou erro definitivo): sem
   * expirar, a sessão ficaria `PENDING` e bloquearia o usuário.
   *
   * O banco pode ser justamente o que derrubou o job, então a expiração é
   * tentada algumas vezes. Se nenhuma passar, o resultado diz `FALHOU` e a
   * sessão vence por tempo na próxima abertura do cartão
   * (`FuelSessionService.abrirSessao`).
   */
  async expirarAposFalhaDoJob(sessionId: string): Promise<ExpiracaoAposFalha> {
    let ultimoErro: unknown;

    for (let tentativa = 1; tentativa <= TENTATIVAS_DE_EXPIRACAO; tentativa++) {
      try {
        const expirada = await this.sessoes.expirar(sessionId);
        return expirada ? 'EXPIRADA' : 'JA_ENCERRADA';
      } catch (erro) {
        ultimoErro = erro;
        if (tentativa < TENTATIVAS_DE_EXPIRACAO) {
          await pausa(PAUSA_ENTRE_TENTATIVAS_MS * tentativa);
        }
      }
    }

    this.logger.error(
      `[FUEL] Não foi possível expirar a FuelSession ${sessionId} após ${TENTATIVAS_DE_EXPIRACAO} tentativas ` +
        `(${ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro)}). ` +
        'Ela segue PENDING e vence por tempo na próxima abertura do cartão.',
    );
    return 'FALHOU';
  }

  private async concluir(
    sessionId: string,
    userId: number,
    diferenca: number,
    novoTotal: number,
  ): Promise<ResultadoDaVerificacao> {
    const concluiu = await this.sessoes.concluir({
      sessionId,
      userId,
      valorDepois: novoTotal,
      diferenca,
    });
    // Outra execução do mesmo job concluiu (ou expirou) primeiro: o push e o
    // total do usuário são de quem ganhou.
    if (!concluiu) return { skipped: true, reason: 'already_processed' };

    const usuario = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { expoPushToken: true },
    });
    if (!usuario?.expoPushToken) {
      this.logger.warn(
        `[FUEL] user ${userId} sem expoPushToken — push de economia não enviado`,
      );
      return { processed: true, diferenca, novoTotal, push: 'sem_token' };
    }

    const { titulo, corpo } = mensagemDeEconomia(diferenca);
    const envio = await this.notifications.sendPushNotification(
      userId,
      usuario.expoPushToken,
      titulo,
      corpo,
      { type: 'fuel_economy', diferenca, novoTotal },
    );
    if (!envio.success) {
      this.logger.warn(
        `[FUEL] push de economia do user ${userId} não entregue: ${envio.message}`,
      );
    }
    return {
      processed: true,
      diferenca,
      novoTotal,
      push: envio.success ? 'enviado' : 'falhou',
    };
  }
}
