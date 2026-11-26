import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ReinspectionBoletoStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  BOLETO_LEASE_MS,
  BoletoReativacaoOrigem,
  estadosQuePermitemGerar,
  inicioDaJanelaDeRetry,
  tentativaVencida,
} from 'src/sga/domain/boleto-geracao';
import {
  BoletoPronto,
  BoletoReativacaoResultado,
  RevistoriaParaBoleto,
  TentativaDeBoleto,
  resultadoDoBoleto,
} from 'src/sga/domain/boleto-resultado';
import { logDoBoleto } from 'src/sga/helpers/boleto-log.helper';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { BoletoDesfechoService } from 'src/sga/services/boleto-desfecho.service';
import { BoletoObtencaoService } from 'src/sga/services/boleto-obtencao.service';

export type { BoletoReativacaoResultado } from 'src/sga/domain/boleto-resultado';

type Opcoes = { origem: BoletoReativacaoOrigem; debugId?: string };

/**
 * Uma tentativa de gerar o boleto de reativação de uma revistoria aprovada.
 *
 * 1. Sai sem fazer nada quando o boleto já existe, quando a revistoria não
 *    passou pelo fluxo (aprovada antes dele) ou quando o retry ainda não
 *    venceu.
 * 2. Reivindica o LEASE da revistoria ANTES de qualquer chamada ao SGA. Quem
 *    não ganha (duplo clique, retry junto com "Gerar agora") não toca o SGA.
 * 3. Com o lease, obtém o boleto (`BoletoObtencaoService`): retoma um que a
 *    API já cadastrou, adota um que já exista no SGA ou cadastra um novo.
 * 4. Entrega o desfecho ao `BoletoDesfechoService`, que grava o estado
 *    (`GERADO`, `PENDENTE_RETRY` ou `FALHA`), solta o lease e avisa.
 *
 * Só lança em revistoria inexistente ou quando nem o desfecho pôde ser
 * gravado (banco fora) — nesse caso o lease vence e a varredura retoma.
 */
@Injectable()
export class GerarBoletoReativacaoService {
  private readonly logger = new Logger(GerarBoletoReativacaoService.name);

  constructor(
    private readonly revistorias: BoletoReativacaoRepository,
    private readonly obtencao: BoletoObtencaoService,
    private readonly desfecho: BoletoDesfechoService,
  ) {}

  async processar(
    reinspectionId: number,
    opcoes: Opcoes,
  ): Promise<BoletoReativacaoResultado> {
    const revistoria = await this.revistorias.carregar(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const agora = new Date();
    const semFazerNada = this.motivoParaNaoTentar(revistoria, opcoes, agora);
    if (semFazerNada) return semFazerNada;

    const { origem, debugId } = opcoes;
    const tentativa: TentativaDeBoleto = {
      revistoria,
      origem,
      debugId,
      dono: randomUUID(),
      numero: revistoria.boletoTentativas + 1,
      agora,
      inicioDaJanela: inicioDaJanelaDeRetry({
        origem,
        statusAnterior: revistoria.boletoStatus,
        retryInicioEm: revistoria.boletoRetryInicioEm,
        agora,
      }),
    };

    // LEASE: só uma tentativa por vez por revistoria, e ela é reivindicada
    // antes de qualquer chamada ao SGA. Quem perde sai sem tocar o SGA.
    const ganhou = await this.revistorias.reivindicarLease({
      reinspectionId: revistoria.id,
      dono: tentativa.dono,
      agora,
      leaseMs: BOLETO_LEASE_MS,
      tentativasLidas: revistoria.boletoTentativas,
      estadosPermitidos: estadosQuePermitemGerar(origem),
      inicioDaJanela: tentativa.inicioDaJanela,
    });
    if (!ganhou) {
      this.log(
        'warn',
        revistoria,
        opcoes,
        'Outra tentativa de boleto em andamento; esta foi ignorada',
        { tentativa: tentativa.numero },
      );
      return this.comoEsta(revistoria);
    }

    let boleto: BoletoPronto;
    try {
      boleto = await this.obtencao.obter(tentativa);
    } catch (error) {
      return this.desfecho.falha(tentativa, error);
    }

    try {
      return await this.desfecho.sucesso(tentativa, boleto);
    } catch (error) {
      // O boleto existe, mas `GERADO` não pôde ser gravado. Um boleto que a
      // API cadastrou fica anotado na revistoria para a retomada.
      return this.desfecho.falha(
        tentativa,
        error,
        boleto.adotado ? null : boleto.nossoNumero,
      );
    }
  }

  /**
   * Casos em que a tentativa nem começa. Devolve o estado atual como
   * `pulado`, ou `null` quando é para tentar.
   */
  private motivoParaNaoTentar(
    revistoria: RevistoriaParaBoleto,
    opcoes: Opcoes,
    agora: Date,
  ): BoletoReativacaoResultado | null {
    const status = revistoria.boletoStatus;

    if (status === ReinspectionBoletoStatus.GERADO) {
      this.log('log', revistoria, opcoes, 'Boleto já gerado; nada a fazer');
      return this.comoEsta(revistoria);
    }

    // Garantia: só a aprovação inicia o processo de boleto. Retry e geração
    // manual atuam apenas em revistorias que já passaram pelo fluxo
    // (PENDENTE_RETRY/FALHA). Revistorias aprovadas antes dele ficam
    // NAO_GERADO para sempre e nunca têm boleto criado retroativamente.
    if (
      opcoes.origem !== 'APROVACAO' &&
      status === ReinspectionBoletoStatus.NAO_GERADO
    ) {
      this.log(
        'warn',
        revistoria,
        opcoes,
        'Revistoria sem tentativa de boleto registrada (anterior ao fluxo); ignorada',
      );
      return this.comoEsta(revistoria, {
        erro: 'Revistoria aprovada antes do fluxo automático de boleto; gere manualmente no SGA',
      });
    }

    // Retry só atua em quem está aguardando retry, e só na hora marcada: um
    // job atrasado antigo que ainda esteja no Redis não antecipa a tentativa
    // nem ressuscita uma revistoria que já falhou de vez.
    if (opcoes.origem === 'RETRY') {
      const aguardando = status === ReinspectionBoletoStatus.PENDENTE_RETRY;
      if (
        !aguardando ||
        !tentativaVencida(revistoria.boletoProximaTentativaEm, agora)
      ) {
        this.log('log', revistoria, opcoes, 'Retry fora de hora; ignorado');
        return this.comoEsta(revistoria, {
          proximaTentativaEm: aguardando
            ? (revistoria.boletoProximaTentativaEm ?? null)
            : null,
        });
      }
    }
    return null;
  }

  /** O estado da revistoria como foi lido, marcado como `pulado`. */
  private comoEsta(
    revistoria: RevistoriaParaBoleto,
    parcial: Partial<BoletoReativacaoResultado> = {},
  ): BoletoReativacaoResultado {
    return resultadoDoBoleto(revistoria.id, {
      status: revistoria.boletoStatus,
      pulado: true,
      nossoNumero: revistoria.boletoNossoNumero,
      tentativas: revistoria.boletoTentativas,
      ...parcial,
    });
  }

  private log(
    nivel: 'log' | 'warn' | 'error',
    revistoria: RevistoriaParaBoleto,
    contexto: Opcoes,
    mensagem: string,
    meta: Record<string, unknown> = {},
  ): void {
    logDoBoleto(
      this.logger,
      GerarBoletoReativacaoService.name,
      nivel,
      {
        reinspectionId: revistoria.id,
        baseOrigin: revistoria.userVehicle.user?.baseOrigin,
        origem: contexto.origem,
        debugId: contexto.debugId,
      },
      mensagem,
      meta,
    );
  }
}
