import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';
import {
  SorteLancamentoTipo,
  SorteMecanica,
  SorteModoCredito,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  erro409,
  erro422,
  erro503,
} from 'src/associado-sorte/helpers/sorte-erros';
import {
  motivoRodadaFechada,
  Semaforo,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  SorteConfigView,
  toMeuPremio,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import {
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { baseTag } from 'src/shared/log.util';

const DIA_MS = 24 * 60 * 60 * 1000;

/** Erros do Prisma de transação que não conseguiu vaga/tempo ou conflitou. */
const ERROS_DE_CONTENCAO = ['P2028', 'P2034'];

/**
 * "Resgatar uma unidade": a mesma operação serve à CORRIDA (primeiro que
 * clicar leva) e ao RESGATE (vitrine). É a parte que não pode falhar: duas
 * pessoas nunca levam a mesma unidade e ninguém gasta o mesmo crédito duas
 * vezes (seção 5.2).
 */
@Injectable()
export class SorteResgateService {
  private readonly logger = new Logger(SorteResgateService.name);

  /**
   * A corrida concentra cliques no mesmo segundo, no mesmo processo e no
   * mesmo pool que atende o resto da API. O semáforo limita quantas
   * transações de resgate ficam abertas ao mesmo tempo; quem espera é
   * recusado na hora (sem transação) assim que as unidades acabam.
   */
  private readonly semaforo = new Semaforo(
    associadoSorteConfig().resgateConcorrenciaMaxima,
  );

  constructor(
    private readonly rateLimit: SorteRateLimitService,
    private readonly acesso: SorteAcessoService,
    private readonly rodadasRepository: SorteRodadasRepository,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly ganhadoresRepository: SorteGanhadoresRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly creditos: SorteCreditosService,
    private readonly ganhadores: SorteGanhadoresService,
    private readonly notificacoes: SorteNotificacoesService,
  ) {}

  async resgatar(params: {
    rodadaId: number;
    userId: number;
    baseOrigin: string;
  }) {
    const { rodadaId, userId, baseOrigin } = params;
    await this.rateLimit.verificar('resgatar', userId);

    // Recusa rápida: leitura simples, sem transação nem trava.
    await this.recusaRapida(rodadaId, baseOrigin);
    const { config } = await this.acesso.validar(userId, baseOrigin);

    let resultado: { ganhadorId: number; saldo: number };
    const liberar = await this.semaforo.adquirir();
    try {
      // Pode ter esgotado enquanto esperava a vez.
      await this.recusaRapida(rodadaId, baseOrigin);
      await this.creditosRepository.garantirCarteira(userId, baseOrigin);
      resultado = await this.uow.executar((tx) =>
        this.resgatarNaTransacao(tx, { rodadaId, userId, baseOrigin, config }),
      );
    } catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError) {
        // Segunda barreira: índice único (rodadaId, userId).
        if (erro.code === 'P2002') {
          throw erro409('JA_GANHOU', 'Você já garantiu este prêmio');
        }
        if (ERROS_DE_CONTENCAO.includes(erro.code)) {
          throw erro503('Muita gente ao mesmo tempo. Tente de novo.');
        }
      }
      throw erro;
    } finally {
      liberar();
    }

    this.logger.log(
      `${baseTag(baseOrigin)} associado #${userId} levou uma unidade da rodada #${rodadaId} (ganhador #${resultado.ganhadorId})`,
    );

    // Depois do commit e sem segurar a resposta: falha de push não desfaz nada.
    this.notificacoes
      .avisarGanhadores([resultado.ganhadorId])
      .catch((erro: Error) =>
        this.logger.error(`Falha ao avisar o ganhador: ${erro.message}`),
      );

    const ganhador = await this.ganhadoresRepository.buscar(
      resultado.ganhadorId,
    );
    return {
      serverNow: new Date(),
      ganhador: toMeuPremio(ganhador!, config.whatsappSuporte),
      saldo: resultado.saldo,
    };
  }

  /** `RODADA_NAO_ABERTA` / `ESGOTADO` / `RODADA_ENCERRADA` sem abrir transação. */
  private async recusaRapida(
    rodadaId: number,
    baseOrigin: string,
  ): Promise<void> {
    const leitura = await this.rodadasRepository.leituraRapida(
      rodadaId,
      baseOrigin,
    );
    if (!leitura) throw new NotFoundException('Rodada não encontrada');
    if (leitura.mecanica === SorteMecanica.SORTEIO) {
      throw new BadRequestException(
        'Esta rodada é um sorteio: use "participar"',
      );
    }
    const agora = new Date();
    const motivo = motivoRodadaFechada(leitura, agora);
    if (motivo) {
      throw erro409(motivo.code, motivo.message, {
        serverNow: agora,
        abertura: leitura.abertura,
      });
    }
  }

  /**
   * Transação curta, travando na ordem rodada → prêmio → carteira e
   * revalidando tudo com as linhas travadas. Sem chamada externa aqui dentro.
   */
  private async resgatarNaTransacao(
    tx: SorteTx,
    params: {
      rodadaId: number;
      userId: number;
      baseOrigin: string;
      config: SorteConfigView;
    },
  ): Promise<{ ganhadorId: number; saldo: number }> {
    const { rodadaId, userId, baseOrigin, config } = params;
    const agora = new Date();

    const rodada = await tx.travarRodada(rodadaId);
    if (!rodada) throw new NotFoundException('Rodada não encontrada');
    if (rodada.mecanica === SorteMecanica.SORTEIO) {
      throw new BadRequestException(
        'Esta rodada é um sorteio: use "participar"',
      );
    }
    const motivo = motivoRodadaFechada(rodada, agora);
    if (motivo) {
      throw erro409(motivo.code, motivo.message, {
        serverNow: agora,
        abertura: rodada.abertura,
      });
    }

    const premio = await tx.travarPremio(rodada.premioId);
    // Estoque zerado por ajuste manual: ninguém leva.
    if (!premio || premio.estoque <= 0) {
      throw erro409('ESGOTADO', 'As unidades desta rodada acabaram');
    }

    const carteira = await tx.travarCarteira(userId);
    if (!carteira) throw new NotFoundException('Carteira não encontrada');

    if (await tx.buscarGanhadorDaRodada(rodadaId, userId)) {
      throw erro409('JA_GANHOU', 'Você já garantiu este prêmio');
    }

    // Vitrine é troca direta: não tem carência.
    if (rodada.mecanica === SorteMecanica.CORRIDA && config.carenciaDias > 0) {
      const desde = new Date(agora.getTime() - config.carenciaDias * DIA_MS);
      if ((await tx.usuariosEmCarencia([userId], desde)).length > 0) {
        throw erro409(
          'EM_CARENCIA',
          `Quem ganhou recentemente aguarda ${config.carenciaDias} dia(s) para concorrer de novo`,
        );
      }
    }

    if (carteira.saldo < rodada.custoCreditos) {
      throw erro422(
        'CREDITOS_INSUFICIENTES',
        'Você não tem créditos suficientes',
        { saldo: carteira.saldo, necessario: rodada.custoCreditos },
      );
    }

    // Vitrine sempre consome; corrida segue o modo do crédito da rodada.
    const consome =
      rodada.mecanica === SorteMecanica.RESGATE ||
      rodada.modoCredito === SorteModoCredito.CONSOME;
    const creditosGastos = consome ? rodada.custoCreditos : 0;

    const ganhador = await this.ganhadores.registrar(tx, {
      rodada,
      premio,
      userId,
      baseOrigin,
      creditosGastos,
    });
    await tx.atualizarRodada(rodadaId, {
      quantidadeRestante: rodada.quantidadeRestante - 1,
    });
    if (creditosGastos > 0) {
      await this.creditos.lancar(tx, carteira, {
        tipo: SorteLancamentoTipo.RESGATE,
        valor: -creditosGastos,
        baseOrigin,
        rodadaId,
        descricao: premio.nome,
      });
    }
    return { ganhadorId: ganhador.id, saldo: carteira.saldo };
  }
}
