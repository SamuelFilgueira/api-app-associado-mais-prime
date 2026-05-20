import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { RastreamentoSoftruck } from '../rastreamento-softruck.service';
import {
  DiaResumoDto,
  HistoricoResumoResponseDto,
} from '../dto/historico-resumo-response.dto';
import { VehicleInfoDto, PeriodInfoDto } from '../dto/historico-response.dto';
import {
  mapearDiaItems,
  calcularResumoSummary,
} from '../mappers/historico-resumo.mapper';
import {
  contarDias,
  gerarListaAcc,
  processarComConcorrencia,
} from '../utils/period.utils';
import { SoftruckByKeysApiResponse } from '../interfaces/softruck-trajectories.interface';

/** Máximo de dias permitidos por consulta */
const MAX_PERIOD_DAYS = 31;

/** Máximo de requisições simultâneas à API Softruck */
const MAX_CONCORRENCIA = 3;

@Injectable()
export class HistoricoResumoService {
  private readonly logger = new Logger(HistoricoResumoService.name);

  constructor(private readonly softruck: RastreamentoSoftruck) {}

  /**
   * Retorna o histórico de trajetórias agrupado por data para o período informado.
   *
   * Fluxo:
   * 1. Valida o período (dataInicial ≤ dataFinal, máx. 31 dias)
   * 2. Resolve vehicleId e deviceId via cache/API Softruck
   * 3. Para cada dia do período, chama /trajectories/by-keys (concorrência: 3)
   * 4. Mapeia os segmentos de cada dia com dados
   * 5. Ordena por data crescente e calcula o sumário
   *
   * NÃO chama /geom — apenas /by-keys (melhor performance).
   *
   * @throws BadRequestException quando o período é inválido
   */

  async obterResumo(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<HistoricoResumoResponseDto> {
    this.validarPeriodo(dataInicial, dataFinal);

    this.logger.log(
      `[${baseOrigin}] obterResumo chassi=${chassi} período=${dataInicial}→${dataFinal}`,
    );

    const { vehicleData, deviceData } =
      await this.softruck.resolveVehicleAndDevice(chassi, baseOrigin, publicKey);

    const accs = gerarListaAcc(dataInicial, dataFinal);

    this.logger.log(
      `[${baseOrigin}] Consultando by-keys para ${accs.length} dia(s) — vehicleId=${vehicleData.id} deviceId=${deviceData.deviceId}`,
    );

    // ── Passo 1: busca by-keys para todos os dias ──────────────
    const byKeysResultados = await processarComConcorrencia(
      accs,
      MAX_CONCORRENCIA,
      (acc) =>
        this.softruck.buscarByKeysPorAcc(
          vehicleData.id,
          deviceData.deviceId,
          acc,
          baseOrigin,
          publicKey,
        ),
    );

    // ── Passo 2: filtra apenas dias com dados válidos ──────────
    const diasComDados = byKeysResultados.filter(
      (r): r is SoftruckByKeysApiResponse => !!r?.data?.id,
    );

    this.logger.log(
      `[${baseOrigin}] ${diasComDados.length} dia(s) com dados de ${accs.length} consultado(s)`,
    );

    // ── Passo 3: mapeia segmentos por dia ─────────────────────
    const dias: DiaResumoDto[] = [];

    for (const byKeys of diasComDados) {
      const dia = mapearDiaItems(byKeys.data, [], this.logger);

      if (dia.items.length === 0) continue;

      dias.push(dia);
    }

    // ── Passo 5: ordena por data crescente e calcula sumário ───
    dias.sort((a, b) => a.acc - b.acc);

    const summary = calcularResumoSummary(dias);

    this.logger.log(
      `[${baseOrigin}] resumo concluído: ${dias.length} dia(s), ` +
        `${summary.totalSegmentos} segmento(s), ` +
        `${summary.distanciaTotalMetros}m, ` +
        `${summary.duracaoTotalSegundos}s`,
    );

    const vehicle: VehicleInfoDto = {
      chassi,
      plate: vehicleData.plate,
      brandName: vehicleData.brandName,
      modelName: vehicleData.modelName,
    };

    const period: PeriodInfoDto = {
      dataInicial,
      dataFinal,
      totalDias: contarDias(dataInicial, dataFinal),
    };

    return { vehicle, period, summary, dias };
  }

  // ============================================================
  // Validações
  // ============================================================

  private validarPeriodo(dataInicial: string, dataFinal: string): void {
    if (dataInicial > dataFinal) {
      throw new BadRequestException(
        'dataInicial não pode ser maior que dataFinal',
      );
    }

    const totalDias = contarDias(dataInicial, dataFinal);
    if (totalDias > MAX_PERIOD_DAYS) {
      throw new BadRequestException(
        `O período máximo permitido é de ${MAX_PERIOD_DAYS} dias`,
      );
    }
  }
}
