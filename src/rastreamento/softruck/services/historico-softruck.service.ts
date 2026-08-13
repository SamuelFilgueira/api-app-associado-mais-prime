import { Injectable, Logger } from '@nestjs/common';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { HistoricoProviderResolverService } from 'src/rastreamento/services/historico-provider-resolver.service';
import { LogicaHistoricoService } from 'src/rastreamento/logica/services/logica-historico.service';
import {
  HistoricoPdfDataDto,
  HistoricoRotasResponseDto,
  HistoricoSegmentoDto,
  VehicleInfoDto,
  PeriodInfoDto,
} from '../dto/historico-response.dto';
import { SoftruckGeomFeature } from '../interfaces/softruck-trajectories.interface';
import {
  mapearSegmentosDoItem,
  calcularSumario,
} from '../mappers/trajetoria-by-keys.mapper';
import { HistoricoPdfSoftruckService } from '../pdf/historico-pdf-softruck.service';
import {
  contarDias,
  gerarListaAcc,
  processarComConcorrencia,
} from '../utils/period.utils';
import { GeomPipelineProcessor } from '../processors/geom-pipeline.processor';

/** Máximo de requisições simultâneas à API Softruck no processamento de período */
const MAX_CONCORRENCIA = 3;

@Injectable()
export class HistoricoSoftruckService {
  private readonly logger = new Logger(HistoricoSoftruckService.name);

  constructor(
    private readonly softruck: RastreamentoSoftruck,
    private readonly pdfService: HistoricoPdfSoftruckService,
    private readonly geomPipeline: GeomPipelineProcessor,
    private readonly providerResolver: HistoricoProviderResolverService,
    private readonly logicaHistorico: LogicaHistoricoService,
  ) {}

  // ============================================================
  // Geração de PDF de trajetórias
  // ============================================================

  /**
   * Orquestra a geração do relatório PDF de trajetórias para o período informado.
   *
   * Fluxo:
   * 1. Resolve vehicleId e deviceId via Softruck (com cache)
   * 2. Itera cada dia do período e consulta /trajectories/by-keys
   * 3. Consolida segmentos e calcula sumário
   * 4. Gera PDF com Puppeteer e retorna Buffer
   */
  async gerarRelatorioPdf(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<Buffer> {
    const { vehicleData, deviceData } =
      await this.softruck.resolveVehicleAndDevice(
        chassi,
        baseOrigin,
        publicKey,
      );

    const accs = gerarListaAcc(dataInicial, dataFinal);

    const resultados = await processarComConcorrencia(
      accs,
      MAX_CONCORRENCIA,
      async (acc) => {
        return this.softruck.buscarByKeysPorAcc(
          vehicleData.id,
          deviceData.deviceId,
          acc,
          baseOrigin,
          publicKey,
        );
      },
    );

    const segmentos: HistoricoSegmentoDto[] = [];
    let diasComDados = 0;

    for (const resultado of resultados) {
      if (!resultado?.data) continue;
      const segsDodia = mapearSegmentosDoItem(resultado.data);
      if (segsDodia.length > 0) {
        diasComDados++;
        segmentos.push(...segsDodia);
      }
    }

    const totalDias = contarDias(dataInicial, dataFinal);
    const summary = calcularSumario(segmentos, diasComDados);

    const vehicle: VehicleInfoDto = {
      chassi,
      plate: vehicleData.plate,
      brandName: vehicleData.brandName,
      modelName: vehicleData.modelName,
    };

    const period: PeriodInfoDto = {
      dataInicial,
      dataFinal,
      totalDias,
    };

    const dadosPdf: HistoricoPdfDataDto = {
      vehicle,
      period,
      summary,
      segmentos,
    };

    return this.pdfService.gerarPdf(dadosPdf);
  }

  // ============================================================
  // Rotas detalhadas em GeoJSON
  // ============================================================

  /**
   * Orquestra a consulta de rotas detalhadas para o período informado.
   *
   * Fluxo:
   * 1. Resolve vehicleId e deviceId
   * 2. Chama by-keys para cada dia para obter enterpriseId e dados de sumário
   * 3. Usando o enterpriseId, chama geom para cada dia
   * 4. Consolida features GeoJSON e retorna resposta estruturada
   */
  async obterRotas(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<HistoricoRotasResponseDto> {
    // Veículos da Lógica caem neste mesmo endpoint (o app publicado não
    // diferencia provider): o resolver detecta e delega, mantendo o contrato
    // de resposta Softruck. Caminho Softruck segue inalterado.
    const resolucao = await this.providerResolver.resolve(
      chassi,
      baseOrigin,
      publicKey,
    );

    if (resolucao.provider === 'logica') {
      return this.logicaHistorico.obterRotas(
        chassi,
        resolucao.veiculo,
        dataInicial,
        dataFinal,
        baseOrigin,
      );
    }

    const { vehicleData, deviceData } = resolucao;

    const accs = gerarListaAcc(dataInicial, dataFinal);

    // FASE 1: by-keys para obter enterpriseId + dados de segmentos para sumário
    const resultadosByKeys = await processarComConcorrencia(
      accs,
      MAX_CONCORRENCIA,
      async (acc) => {
        return this.softruck.buscarByKeysPorAcc(
          vehicleData.id,
          deviceData.deviceId,
          acc,
          baseOrigin,
          publicKey,
        );
      },
    );

    // Extrai enterpriseId do primeiro resultado com dados
    let enterpriseId: string | null = null;
    const segmentos: HistoricoSegmentoDto[] = [];
    let diasComDados = 0;

    for (const resultado of resultadosByKeys) {
      if (!resultado?.data) continue;

      if (!enterpriseId) {
        enterpriseId = resultado.data.relationships?.enterprise?.id ?? null;
        if (enterpriseId) {
          this.logger.log(
            `[${baseOrigin}] enterpriseId resolvido: ${enterpriseId}`,
          );
        }
      }

      const segsDodia = mapearSegmentosDoItem(resultado.data);
      if (segsDodia.length > 0) {
        diasComDados++;
        segmentos.push(...segsDodia);
      }
    }

    if (!enterpriseId) {
      this.logger.warn(
        `[${baseOrigin}] Nenhum enterpriseId encontrado nas respostas by-keys para o período ${dataInicial}→${dataFinal}`,
      );
    }

    // FASE 2: geom para obter pontos GPS detalhados
    const todasFeatures: SoftruckGeomFeature[] = [];

    if (enterpriseId) {
      const resultadosGeom = await processarComConcorrencia(
        accs,
        MAX_CONCORRENCIA,
        async (acc) => {
          return this.softruck.buscarGeomPorAcc(
            vehicleData.id,
            deviceData.deviceId,
            enterpriseId,
            acc,
            baseOrigin,
            publicKey,
          );
        },
      );

      for (const featureCollection of resultadosGeom) {
        if (featureCollection?.features?.length) {
          todasFeatures.push(...featureCollection.features);
        }
      }
    }

    // Pipeline de processamento: simplificação de rota + filtragem de alarmes
    const pipeline = this.geomPipeline.process(todasFeatures, segmentos);

    const totalDias = contarDias(dataInicial, dataFinal);
    const summaryBase = calcularSumario(segmentos, diasComDados);

    const vehicle: VehicleInfoDto = {
      chassi,
      plate: vehicleData.plate,
      brandName: vehicleData.brandName,
      modelName: vehicleData.modelName,
    };

    const period: PeriodInfoDto = {
      dataInicial,
      dataFinal,
      totalDias,
    };

    return {
      vehicle,
      period,
      summary: {
        ...summaryBase,
        totalFeaturesDetalhadas: pipeline.stats.simplifiedRoutePoints,
        totalAlarmes: pipeline.stats.filteredAlarms,
      },
      geojson: pipeline.geojson,
      segments: pipeline.segments,
      grouped: {
        routeFeatures: pipeline.routeFeatures,
        alarmFeatures: pipeline.alarmFeatures,
      },
    };
  }
}
