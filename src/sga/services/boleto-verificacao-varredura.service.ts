import { Injectable, Logger } from '@nestjs/common';
import { isTenantBase } from 'src/config/tenant.config';
import { metricas } from 'src/infra/observability/metricas';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import {
  BoletoVerificacaoConfig,
  excedeuIdadeMaxima,
  getBoletoVerificacaoConfig,
} from 'src/sga/config/boleto-verificacao.config';
import { proximaConsultaEm } from 'src/sga/domain/boleto-situacao';
import { resumirErros } from 'src/sga/helpers/resumo-de-erros.helper';
import {
  PagamentoBoletoRepository,
  PagamentoReservado,
} from 'src/sga/repositories/pagamento-boleto.repository';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';

/** Boletos reservados de cada vez. */
const LOTE = 10;
/**
 * Por quanto tempo a reserva segura a linha. Cobre com folga o
 * processamento de um lote inteiro (cada boleto faz de 1 a 4 chamadas ao
 * SGA, espaçadas); se o processo morrer no meio, as linhas voltam sozinhas
 * à varredura quando a reserva vence.
 */
const RESERVA_MS = 10 * 60_000;
/** Reserva a menos disto do fim não é mais processada nesta rodada. */
const MARGEM_DA_RESERVA_MS = 3 * 60_000;
/** Depois deste tempo a rodada não reserva outro lote (a próxima continua). */
const PRAZO_DA_RODADA_MS = 45_000;

export interface ResumoDaVarreduraDeBoletos {
  reservados: number;
  emAberto: number;
  encerrados: number;
  expirados: number;
  /** Reservados que ficaram para depois (reserva perto de vencer). */
  adiados: number;
  falhas: number;
}

/**
 * Verificação de pagamento por VARREDURA: um único job periódico acompanha
 * todos os boletos de reativação, em vez de um job repetível por boleto.
 *
 * A linha de `ReinspectionPayment` diz quando consultar (`proximaConsultaEm`)
 * e quando parar (`verificacaoEncerradaEm`). Cada rodada reserva um lote de
 * linhas vencidas (`SKIP LOCKED`: duas varreduras nunca pegam a mesma) e
 * processa uma a uma, fora da transação e com o espaçamento entre chamadas
 * ao SGA — o volume de consultas é limitado pelo ritmo da varredura, não
 * pela quantidade de boletos em aberto.
 */
@Injectable()
export class BoletoVerificacaoVarreduraService {
  private readonly logger = new Logger(BoletoVerificacaoVarreduraService.name);
  private readonly config: BoletoVerificacaoConfig =
    getBoletoVerificacaoConfig();

  constructor(
    private readonly pagamentos: PagamentoBoletoRepository,
    private readonly verificacao: VerificarPagamentoBoletoService,
  ) {}

  async executar(): Promise<ResumoDaVarreduraDeBoletos> {
    const inicio = Date.now();
    const resumo: ResumoDaVarreduraDeBoletos = {
      reservados: 0,
      emAberto: 0,
      encerrados: 0,
      expirados: 0,
      adiados: 0,
      falhas: 0,
    };
    const erros: string[] = [];

    while (Date.now() - inicio < PRAZO_DA_RODADA_MS) {
      const lote = await this.pagamentos.reservarLote({
        agora: new Date(),
        limite: LOTE,
        reservaMs: RESERVA_MS,
      });
      if (lote.length === 0) break;
      resumo.reservados += lote.length;

      for (const linha of lote) {
        // Processar depois que a reserva vence abriria espaço para outra
        // varredura pegar a mesma linha: o que sobrou fica para depois.
        if (Date.now() >= linha.reservadaAte.getTime() - MARGEM_DA_RESERVA_MS) {
          resumo.adiados += 1;
          continue;
        }
        try {
          await this.processar(linha, resumo);
        } catch (error) {
          // Nada foi encerrado: a linha volta à varredura no ritmo da idade
          // do boleto, e a rodada termina como falha com todas as que erraram.
          resumo.falhas += 1;
          erros.push(
            `boleto ${linha.nossoNumero}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.pagamentos.reagendar(linha.id, this.proxima(linha));
        }
      }
      if (lote.length < LOTE) break;
    }

    if (erros.length > 0) {
      throw new Error(
        `Verificação de boletos: ${erros.length} de ${resumo.reservados} não concluíram — ${resumirErros(erros)}`,
      );
    }
    return resumo;
  }

  private async processar(
    linha: PagamentoReservado,
    resumo: ResumoDaVarreduraDeBoletos,
  ): Promise<void> {
    const agora = Date.now();
    const criadoEm = linha.boletoCriadoEm.getTime();
    const nossoNumero = linha.nossoNumero;

    // Só entra na varredura boleto com `nosso_numero` e código de veículo;
    // uma linha sem eles não tem como ser verificada.
    if (!nossoNumero || !linha.codigoVeiculo) {
      throw new Error(
        `linha ${linha.id} na varredura sem nosso_numero ou codigo_veiculo`,
      );
    }

    if (excedeuIdadeMaxima(this.config, criadoEm, agora)) {
      this.logger.warn(
        `Verificação encerrada: boleto nosso_numero=${nossoNumero} além da idade máxima (${this.config.maxDias} dias, criado em ${linha.boletoCriadoEm.toISOString()}) — ${linha.pago ? 'PAGO, mas a reativação no SGA nunca foi aceita' : 'sem pagamento'}`,
      );
      metricas.boletoReativacao.inc({
        base: linha.baseOrigin ?? 'n/a',
        evento: 'expirado',
      });
      await this.pagamentos.encerrar(nossoNumero, new Date(agora));
      resumo.expirados += 1;
      return;
    }

    const base = await this.resolverBase(linha);
    const desfecho = await this.verificacao.verificar(
      {
        userVehicleId: linha.userVehicleId,
        nossoNumero,
        codigoVeiculo: linha.codigoVeiculo,
        codigoAssociado: linha.codigoAssociado,
        nomeAssociado: linha.nomeAssociado,
        telefoneAssociado: linha.telefoneAssociado,
      },
      base,
      linha,
    );

    if (desfecho === 'EM_ABERTO' || desfecho === 'SEM_RESPOSTA') {
      await this.pagamentos.reagendar(linha.id, this.proxima(linha));
      resumo.emAberto += 1;
      return;
    }
    resumo.encerrados += 1;
  }

  /** Próxima consulta pela idade do boleto (2 min → 10 min → 60 min). */
  private proxima(linha: PagamentoReservado): Date {
    return proximaConsultaEm(this.config, {
      criadoEm: linha.boletoCriadoEm.getTime(),
      agora: Date.now(),
    });
  }

  /**
   * Base gravada na linha; se faltar ou não for deste deploy, a do dono do
   * veículo. Sem base válida a linha falha — nunca usa a base padrão.
   */
  private async resolverBase(linha: PagamentoReservado): Promise<BaseOrigin> {
    if (isTenantBase(linha.baseOrigin)) return linha.baseOrigin;
    return exigirBase(
      await this.pagamentos.baseDoDonoDoVeiculo(linha.userVehicleId),
      'verificação de boleto (user.baseOrigin do veículo)',
    );
  }
}
