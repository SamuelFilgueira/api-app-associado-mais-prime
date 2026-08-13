import { Injectable, Logger } from '@nestjs/common';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';
import {
  RastreamentoSoftruck,
  SoftruckVehicleNotFoundException,
} from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import {
  LogicaVeiculoInfo,
  TrajetosService,
} from 'src/rastreamento/logica/services/trajetos.service';

/** TTL do cache de provider por chassi (10 minutos) */
const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1000;

export type ProviderResolution =
  | {
      provider: 'softruck';
      vehicleData: {
        id: string;
        plate: string;
        brandName: string;
        modelName: string;
      };
      deviceData: { vehicleId: string; deviceId: string };
    }
  | { provider: 'logica'; veiculo: LogicaVeiculoInfo };

/**
 * Decide qual provedor de rastreamento serve o histórico de um chassi.
 *
 * Não existe campo de provider por veículo no banco — a detecção é por
 * tentativa, com o caminho Softruck intacto: a sonda na Lógica só acontece
 * depois de SoftruckVehicleNotFoundException. Qualquer outra falha Softruck
 * é propagada (Softruck fora do ar não vira fallback silencioso), e se a
 * sonda não encontra o chassi (ou falha), o erro Softruck original é
 * relançado — mesma mensagem/status de hoje para chassi inexistente.
 */
@Injectable()
export class HistoricoProviderResolverService {
  private readonly logger = new Logger(HistoricoProviderResolverService.name);

  private readonly providerCache = new Map<
    string,
    { value: 'softruck' | 'logica'; expiresAt: number }
  >();

  constructor(
    private readonly softruck: RastreamentoSoftruck,
    private readonly trajetos: TrajetosService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  async resolve(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<ProviderResolution> {
    const cacheKey = `${baseOrigin}:${chassi}`;
    const cached = this.providerCache.get(cacheKey);

    // Cache hit 'logica': evita nova tentativa Softruck; a busca na lista é
    // barata (token cacheado). Se o veículo saiu da Lógica, invalida e segue
    // o fluxo normal.
    if (cached && cached.expiresAt > Date.now() && cached.value === 'logica') {
      const veiculo = await this.buscarVeiculoLogica(chassi, baseOrigin);
      if (veiculo) {
        return { provider: 'logica', veiculo };
      }
      this.providerCache.delete(cacheKey);
    }

    try {
      const { vehicleData, deviceData } =
        await this.softruck.resolveVehicleAndDevice(
          chassi,
          baseOrigin,
          publicKey,
        );

      this.setCache(cacheKey, 'softruck');
      return { provider: 'softruck', vehicleData, deviceData };
    } catch (erroSoftruck) {
      if (!(erroSoftruck instanceof SoftruckVehicleNotFoundException)) {
        throw erroSoftruck;
      }

      let veiculo: LogicaVeiculoInfo | null;
      try {
        veiculo = await this.buscarVeiculoLogica(chassi, baseOrigin);
      } catch (erroLogica) {
        const mensagem =
          erroLogica instanceof Error ? erroLogica.message : String(erroLogica);
        this.logger.warn(
          `[${baseOrigin}] Sonda na Lógica falhou para chassi ${chassi}; mantendo erro Softruck original: ${mensagem}`,
        );
        throw erroSoftruck;
      }

      if (!veiculo) {
        // Chassi inexistente nos dois providers: mesma resposta de hoje
        throw erroSoftruck;
      }

      this.logger.log(
        `[${baseOrigin}] Chassi ${chassi} identificado como veículo Lógica (veiculoId=${veiculo.id})`,
      );
      this.setCache(cacheKey, 'logica');
      return { provider: 'logica', veiculo };
    }
  }

  private async buscarVeiculoLogica(
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<LogicaVeiculoInfo | null> {
    const token = this.tokenResolver.resolveLogicaToken(baseOrigin);
    return this.trajetos.buscarVeiculoPorChassi(chassi, baseOrigin, token);
  }

  private setCache(cacheKey: string, value: 'softruck' | 'logica'): void {
    this.providerCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
    });
  }
}
