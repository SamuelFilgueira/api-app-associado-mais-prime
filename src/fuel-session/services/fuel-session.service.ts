import { Injectable, Logger } from '@nestjs/common';
import { FuelSession } from '@prisma/client';
import { BaseOrigin } from 'src/config/tenant.config';
import { interpretarTotalEconomizado } from 'src/economia/domain/total-economizado';
import { EconomiaService } from 'src/economia/services/economia.service';
import {
  ATRASO_DA_PRIMEIRA_CHECAGEM_MS,
  DadosDaChecagem,
  JOB_CHECAR_ECONOMIA,
  corteDeSessaoPendente,
  jobIdDaChecagem,
} from 'src/fuel-session/domain/verificacao-de-economia';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { FUEL_ECONOMY_QUEUE } from 'src/queue/queue.module';
import { baseTag } from 'src/shared/log.util';

export type AberturaDeSessao =
  /** Sessão criada e primeira checagem agendada. */
  | { situacao: 'ABERTA'; sessao: FuelSession }
  /** O usuário já tinha uma sessão pendente: é ela que vale. */
  | { situacao: 'JA_PENDENTE'; sessao: FuelSession }
  /** O Clubgas não devolveu um total numérico: sem valor de partida, sem sessão. */
  | { situacao: 'SEM_VALOR_DE_PARTIDA'; sessao: null };

/**
 * Abertura da sessão de verificação de economia, chamada quando o associado
 * abre o cartão virtual.
 */
@Injectable()
export class FuelSessionService {
  private readonly logger = new Logger(FuelSessionService.name);

  constructor(
    private readonly sessoes: FuelSessionRepository,
    private readonly economia: EconomiaService,
    private readonly produtor: ProdutorDeFilas,
  ) {}

  /**
   * Abre a sessão `PENDING` do usuário e agenda a primeira checagem.
   *
   * O valor de partida (`valorAntes`) é o total economizado lido do Clubgas
   * AGORA. Antes vinha de `user.totalEconomizado`, que só é atualizado quando
   * o associado abre a tela de economia: com o cadastro defasado, a primeira
   * checagem via "aumento" e o push anunciava uma economia de abastecimentos
   * antigos.
   *
   * Falha do Clubgas nessa leitura sai daqui como a exceção de
   * `EconomiaService` (já gravada em `ClubgasErroLog`): sem valor de partida
   * confiável não há sessão.
   */
  async abrirSessao(
    userId: number,
    base: BaseOrigin,
  ): Promise<AberturaDeSessao> {
    const tag = `${baseTag(base)} [FUEL]`;

    // Sessão pendente que ninguém encerrou (job perdido, falha ao expirar)
    // vence por tempo aqui, em vez de bloquear o usuário para sempre.
    const vencidas = await this.sessoes.expirarPendentesVencidas(
      userId,
      corteDeSessaoPendente(new Date()),
    );
    if (vencidas > 0) {
      this.logger.warn(
        `${tag} ${vencidas} sessão(ões) pendente(s) órfã(s) do user ${userId} expirada(s) por tempo`,
      );
    }

    // Evita a ida ao Clubgas no segundo toque. Quem fecha a corrida entre
    // dois toques simultâneos é o índice único, em `criarPendente`.
    const pendente = await this.sessoes.buscarPendenteDoUsuario(userId);
    if (pendente) return { situacao: 'JA_PENDENTE', sessao: pendente };

    const resposta = (await this.economia.consultarTotalEconomizado(
      userId,
      'APP',
    )) as { totalEconomizado?: unknown } | null;
    const valorAntes = interpretarTotalEconomizado(resposta?.totalEconomizado);
    if (valorAntes === null) {
      this.logger.warn(
        `${tag} Clubgas não devolveu um total numérico para o user ${userId} — verificação de economia não aberta`,
      );
      return { situacao: 'SEM_VALOR_DE_PARTIDA', sessao: null };
    }

    const { sessao, criada } = await this.sessoes.criarPendente(
      userId,
      valorAntes,
    );
    if (!criada) return { situacao: 'JA_PENDENTE', sessao };

    const dados: DadosDaChecagem = { fuelSessionId: sessao.id, checagem: 1 };
    try {
      await this.produtor.enfileirar(
        FUEL_ECONOMY_QUEUE,
        JOB_CHECAR_ECONOMIA,
        dados,
        {
          base,
          atrasoMs: ATRASO_DA_PRIMEIRA_CHECAGEM_MS,
          jobId: jobIdDaChecagem(sessao.id, 1),
        },
      );
    } catch (erro) {
      // Sem o job ninguém encerraria a sessão: ela é desfeita e o erro segue.
      await this.sessoes.expirar(sessao.id);
      throw erro;
    }

    return { situacao: 'ABERTA', sessao };
  }
}
