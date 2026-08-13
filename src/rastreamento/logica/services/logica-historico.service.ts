import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';
import { LogicaVeiculoInfo, TrajetosService } from './trajetos.service';
import { TrajetoRelatorio } from '../dto/trajeto.dto';
import {
  enriquecerEnderecosComParadas,
  mapearResumoDias,
  mapearRotasFeatures,
  mapearSegmentosHistorico,
  mapearVehicleInfo,
  segmentarViagens,
  ViagemLogica,
} from '../mappers/logica-historico.mapper';
import { HistoricoResumoResponseDto } from 'src/rastreamento/softruck/dto/historico-resumo-response.dto';
import {
  HistoricoRotasResponseDto,
  PeriodInfoDto,
} from 'src/rastreamento/softruck/dto/historico-response.dto';
import { calcularResumoSummary } from 'src/rastreamento/softruck/mappers/historico-resumo.mapper';
import { calcularSumario } from 'src/rastreamento/softruck/mappers/trajetoria-by-keys.mapper';
import { contarDias } from 'src/rastreamento/softruck/utils/period.utils';
import { buildRouteSegments } from 'src/rastreamento/softruck/helpers/trip-segmenter.helper';
import { SoftruckGeomFeatureCollection } from 'src/rastreamento/softruck/interfaces/softruck-trajectories.interface';

/**
 * Serve os endpoints de histórico do app (contrato Softruck) com dados do
 * /mobile/trajeto da Lógica. Camada de compatibilidade permanente enquanto
 * existirem versões do app publicadas que só conhecem os endpoints Softruck;
 * independente do ponto de entrada — a futura rota unificada v2 consumirá
 * estes mesmos métodos.
 */
@Injectable()
export class LogicaHistoricoService {
  private readonly logger = new Logger(LogicaHistoricoService.name);

  constructor(
    private readonly trajetos: TrajetosService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  /** Resposta no shape do /rastreamento/softruck/historico/resumo */
  async obterResumo(
    chassi: string,
    veiculo: LogicaVeiculoInfo,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoResumoResponseDto> {
    const viagens = await this.montarViagens(
      veiculo.id,
      dataInicial,
      dataFinal,
      baseOrigin,
    );

    const dias = mapearResumoDias(viagens, veiculo.id);
    const summary = calcularResumoSummary(dias);

    return {
      vehicle: mapearVehicleInfo(chassi, veiculo),
      period: this.montarPeriodo(dataInicial, dataFinal),
      summary,
      dias,
    };
  }

  /** Resposta no shape do /rastreamento/historico/softruck/rotas */
  async obterRotas(
    chassi: string,
    veiculo: LogicaVeiculoInfo,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoRotasResponseDto> {
    const viagens = await this.montarViagens(
      veiculo.id,
      dataInicial,
      dataFinal,
      baseOrigin,
    );

    const segmentos = mapearSegmentosHistorico(viagens, veiculo.id);

    // Sem pipeline de simplificação: a trilha vai completa para o app, como
    // na plataforma da Lógica — todos os pontos do deslocamento são desenhados
    const features = mapearRotasFeatures(viagens);
    const geojson: SoftruckGeomFeatureCollection = {
      type: 'FeatureCollection',
      features,
    };

    const diasComDados = new Set(segmentos.map((s) => s.acc)).size;
    const summaryBase = calcularSumario(segmentos, diasComDados);

    return {
      vehicle: mapearVehicleInfo(chassi, veiculo),
      period: this.montarPeriodo(dataInicial, dataFinal),
      summary: {
        ...summaryBase,
        totalFeaturesDetalhadas: features.length,
        totalAlarmes: 0,
      },
      geojson,
      segments: buildRouteSegments(segmentos),
      grouped: {
        routeFeatures: features,
        alarmFeatures: [],
      },
    };
  }

  /**
   * Monta os deslocamentos do período combinando os dois endpoints da Lógica:
   *
   * - /mobile/posicao — trilha COMPLETA de posições (o /mobile/trajeto trunca
   *   posicoes[] para períodos já consolidados). É a fonte da segmentação.
   * - /mobile/trajeto — usado pelas paradas[], que trazem os endereços de
   *   início/fim (as posições cruas vêm sem endereço). Suas posicoes[]
   *   servem apenas de fallback quando o /posicao falha ou vem vazio.
   *
   * Período único (00:00 da dataInicial → 23:59 da dataFinal); o agrupamento
   * por dia é feito localmente nos mappers.
   */
  private async montarViagens(
    veiculoId: number,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<ViagemLogica[]> {
    try {
      const token = this.tokenResolver.resolveLogicaToken(baseOrigin);

      const [resposta, posicoesCompletas] = await Promise.all([
        this.trajetos.obterTrajeto(
          veiculoId,
          dataInicial,
          dataFinal,
          baseOrigin,
          token,
        ),
        this.trajetos
          .obterPosicoes(veiculoId, dataInicial, dataFinal, baseOrigin, token)
          .catch((error: unknown) => {
            const mensagem =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `[${baseOrigin}] /mobile/posicao falhou (veiculoId=${veiculoId}); usando posicoes do /mobile/trajeto como fallback: ${mensagem}`,
            );
            return [];
          }),
      ]);

      const relatorio =
        resposta?.relatorio ??
        ({
          paradas: [],
          posicoes: [],
          resumo: null,
          eventoMotorista: [],
        } as unknown as TrajetoRelatorio);

      if (posicoesCompletas.length === 0) {
        this.logger.warn(
          `[${baseOrigin}] /mobile/posicao sem dados (veiculoId=${veiculoId}, periodo=${dataInicial}→${dataFinal}); segmentando com as posicoes do /mobile/trajeto`,
        );
      }

      const viagens = segmentarViagens({
        ...relatorio,
        posicoes:
          posicoesCompletas.length > 0
            ? posicoesCompletas
            : relatorio.posicoes,
      });

      return enriquecerEnderecosComParadas(viagens, relatorio?.paradas ?? []);
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[${baseOrigin}] Falha ao consultar histórico na API Lógica (veiculoId=${veiculoId}, periodo=${dataInicial}→${dataFinal}): ${mensagem}`,
      );
      throw new InternalServerErrorException(
        'Falha ao consultar histórico de trajetos na API Lógica',
      );
    }
  }

  private montarPeriodo(dataInicial: string, dataFinal: string): PeriodInfoDto {
    return {
      dataInicial,
      dataFinal,
      totalDias: contarDias(dataInicial, dataFinal),
    };
  }
}
