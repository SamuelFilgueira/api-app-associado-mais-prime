import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SorteLancamentoTipo,
  SorteMecanica,
  SorteModoCredito,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro409, erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import { motivoRodadaFechada } from 'src/associado-sorte/helpers/sorte.helpers';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { baseTag } from 'src/shared/log.util';

const DIA_MS = 24 * 60 * 60 * 1000;

/** Inscrição em sorteio e lembretes ("Avise-me"). */
@Injectable()
export class SorteParticipacaoService {
  private readonly logger = new Logger(SorteParticipacaoService.name);

  constructor(
    private readonly rateLimit: SorteRateLimitService,
    private readonly acesso: SorteAcessoService,
    private readonly rodadasRepository: SorteRodadasRepository,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly creditos: SorteCreditosService,
  ) {}

  /**
   * Inscreve o associado no sorteio. `CONSOME`: debita `custo × bilhetes`.
   * `SALDO_MINIMO`: basta ter o saldo, nada é debitado e vale um bilhete.
   */
  async participar(params: {
    rodadaId: number;
    userId: number;
    baseOrigin: string;
    bilhetes?: number;
  }) {
    const { rodadaId, userId, baseOrigin } = params;
    await this.rateLimit.verificar('participar', userId);

    // Recusa rápida: leitura simples, sem transação nem trava.
    const leitura = await this.rodadasRepository.leituraRapida(
      rodadaId,
      baseOrigin,
    );
    if (!leitura) throw new NotFoundException('Rodada não encontrada');
    if (leitura.mecanica !== SorteMecanica.SORTEIO) {
      throw new BadRequestException('Esta rodada não é um sorteio');
    }
    this.exigirAberta(leitura);

    const { config } = await this.acesso.validar(userId, baseOrigin);
    await this.creditosRepository.garantirCarteira(userId, baseOrigin);

    let resultado: { bilhetes: number; creditosGastos: number; saldo: number };
    try {
      resultado = await this.uow.executar(async (tx) => {
        const agora = new Date();
        const rodada = await tx.travarRodada(rodadaId);
        if (!rodada) throw new NotFoundException('Rodada não encontrada');
        this.exigirAberta(rodada, agora);

        const carteira = await tx.travarCarteira(userId);
        if (!carteira) throw new NotFoundException('Carteira não encontrada');

        if (await tx.buscarParticipacao(rodadaId, userId)) {
          throw erro409(
            'JA_PARTICIPANDO',
            'Você já está participando deste sorteio',
          );
        }
        if (config.carenciaDias > 0) {
          const desde = new Date(
            agora.getTime() - config.carenciaDias * DIA_MS,
          );
          const emCarencia = await tx.usuariosEmCarencia([userId], desde);
          if (emCarencia.length > 0) {
            throw erro409(
              'EM_CARENCIA',
              `Quem ganhou recentemente aguarda ${config.carenciaDias} dia(s) para concorrer de novo`,
            );
          }
        }

        const consome = rodada.modoCredito === SorteModoCredito.CONSOME;
        const bilhetes = consome ? (params.bilhetes ?? 1) : 1;
        if (bilhetes > rodada.bilhetesMaximos) {
          throw erro422(
            'BILHETES_INVALIDOS',
            `O máximo é ${rodada.bilhetesMaximos} bilhete(s) por associado`,
          );
        }
        const custoTotal = consome
          ? rodada.custoCreditos * bilhetes
          : rodada.custoCreditos;
        if (carteira.saldo < custoTotal) {
          throw erro422(
            'CREDITOS_INSUFICIENTES',
            'Você não tem créditos suficientes',
            { saldo: carteira.saldo, necessario: custoTotal },
          );
        }

        const creditosGastos = consome ? custoTotal : 0;
        await tx.criarParticipacao({
          rodadaId,
          userId,
          baseOrigin,
          bilhetes,
          creditosGastos,
        });
        if (creditosGastos > 0) {
          await this.creditos.lancar(tx, carteira, {
            tipo: SorteLancamentoTipo.PARTICIPACAO_SORTEIO,
            valor: -creditosGastos,
            baseOrigin,
            rodadaId,
            descricao: `${bilhetes} bilhete(s) no sorteio`,
          });
        }
        return { bilhetes, creditosGastos, saldo: carteira.saldo };
      });
    } catch (erro) {
      // Segunda barreira: índice único (rodadaId, userId).
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002'
      ) {
        throw erro409(
          'JA_PARTICIPANDO',
          'Você já está participando deste sorteio',
        );
      }
      throw erro;
    }

    this.logger.log(
      `${baseTag(baseOrigin)} associado #${userId} inscrito no sorteio #${rodadaId} com ${resultado.bilhetes} bilhete(s)`,
    );
    return {
      serverNow: new Date(),
      participacao: {
        rodadaId,
        bilhetes: resultado.bilhetes,
        creditosGastos: resultado.creditosGastos,
      },
      saldo: resultado.saldo,
    };
  }

  /** Liga o "Avise-me". Só faz sentido antes da abertura. */
  async ligarLembrete(params: {
    rodadaId: number;
    userId: number;
    baseOrigin: string;
  }) {
    await this.acesso.validar(params.userId, params.baseOrigin);
    const leitura = await this.rodadasRepository.leituraRapida(
      params.rodadaId,
      params.baseOrigin,
    );
    if (!leitura) throw new NotFoundException('Rodada não encontrada');
    if (Date.now() >= leitura.abertura.getTime()) {
      throw erro409('RODADA_JA_ABERTA', 'Esta rodada já abriu');
    }
    await this.rodadasRepository.criarLembrete(params.rodadaId, params.userId);
    return { rodadaId: params.rodadaId, lembrete: true };
  }

  async desligarLembrete(params: { rodadaId: number; userId: number }) {
    await this.rodadasRepository.removerLembrete(
      params.rodadaId,
      params.userId,
    );
    return { rodadaId: params.rodadaId, lembrete: false };
  }

  private exigirAberta(
    rodada: Parameters<typeof motivoRodadaFechada>[0],
    agora: Date = new Date(),
  ): void {
    const motivo = motivoRodadaFechada(rodada, agora);
    if (motivo) {
      throw erro409(motivo.code, motivo.message, { serverNow: agora });
    }
  }
}
