import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import {
  M7ConsultaVeiculoResponse,
  M7HistoricoApiResponse,
  M7TrajetosApiResponse,
} from '../interfaces/m7-historico.interface';
import {
  DiaM7ResumoDto,
  HistoricoM7PdfDataDto,
  HistoricoM7ResumoResponseDto,
  HistoricoM7RotasResponseDto,
  ViagemM7Dto,
} from '../dto/historico-m7-response.dto';
import { filtrarTrajetos } from '../helpers/m7-trajetos-filter.helper';
import { sanitizarPontosGps } from '../helpers/m7-gps-sanitizer.helper';
import { HistoricoPdfM7Service } from '../pdf/historico-pdf-m7.service';

const M7_REQUEST_TIMEOUT = 25_000;

const M7_CREDENTIALS: Record<
  BaseOrigin,
  { tokenEnvVar: string; codigoEnvVar: string }
> = {
  MAIS_PRIME: { tokenEnvVar: 'MO7_TOKEN', codigoEnvVar: 'M07_CODIGO' },
  MAIS_PRIME_RS: { tokenEnvVar: 'MO7_TOKEN_RS', codigoEnvVar: 'M07_CODIGO_RS' },
};

type TokenState = {
  token: string | null;
  tokenExpires: number | null;
  tokenRenewalPromise: Promise<void> | null;
};

/** Converte YYYY-MM-DD para 'YYYY-MM-DD 00:00:00' (trajetos API) */
function toDateTimeParam(date: string): string {
  return `${date} 00:00:00`;
}

@Injectable()
export class HistoricoM7Service {
  private readonly logger = new Logger(HistoricoM7Service.name);

  private readonly tokenState: Record<BaseOrigin, TokenState> = {
    MAIS_PRIME: { token: null, tokenExpires: null, tokenRenewalPromise: null },
    MAIS_PRIME_RS: {
      token: null,
      tokenExpires: null,
      tokenRenewalPromise: null,
    },
  };

  constructor(private readonly pdfService: HistoricoPdfM7Service) {
    void this.renovarToken('MAIS_PRIME');
    void this.renovarToken('MAIS_PRIME_RS');

    setInterval(() => {
      this.renovarToken('MAIS_PRIME').catch(() => {});
      this.renovarToken('MAIS_PRIME_RS').catch(() => {});
    }, 1_800_000).unref();
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  async renovarToken(baseOrigin: BaseOrigin = 'MAIS_PRIME') {
    const state = this.tokenState[baseOrigin];

    if (state.tokenRenewalPromise) {
      await state.tokenRenewalPromise;
      return { token: state.token, expires_in: state.tokenExpires };
    }

    state.tokenRenewalPromise = this.executeRenovarToken(baseOrigin);

    try {
      await state.tokenRenewalPromise;
      return { token: state.token, expires_in: state.tokenExpires };
    } finally {
      state.tokenRenewalPromise = null;
    }
  }

  private async executeRenovarToken(baseOrigin: BaseOrigin): Promise<void> {
    const { tokenEnvVar, codigoEnvVar } = M7_CREDENTIALS[baseOrigin];
    const apiM7Token = process.env[tokenEnvVar];
    const codigo = process.env[codigoEnvVar];

    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL}login`,
        { codigo, api_m7_token: apiM7Token },
        { timeout: M7_REQUEST_TIMEOUT },
      );

      if (response.data?.sucesso) {
        this.tokenState[baseOrigin].token = response.data.token;
        this.tokenState[baseOrigin].tokenExpires = response.data.expires_in;
        return;
      }

      this.logger.error(
        `[${baseOrigin}] Falha ao renovar token - sucesso=false`,
      );
      throw new InternalServerErrorException('Falha ao renovar token');
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] Erro ao renovar token: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
      );
      throw new InternalServerErrorException('Erro ao renovar token');
    }
  }

  private isTokenError(response: {
    status: number;
    data: Record<string, unknown> | null;
  }): boolean {
    return (
      response.status === 401 ||
      (response.data !== null &&
        typeof response.data === 'object' &&
        typeof response.data.mensagem === 'string' &&
        response.data.mensagem.toLowerCase().includes('token'))
    );
  }

  private async executarComReautenticacao<T>(
    baseOrigin: BaseOrigin,
    request: (token: string) => Promise<{ status: number; data: T }>,
  ): Promise<T> {
    const state = this.tokenState[baseOrigin];

    if (!state.token) {
      this.logger.error(`[${baseOrigin}] Token não disponível`);
      throw new InternalServerErrorException('Token não disponível');
    }

    try {
      const response = await request(state.token);
      return response.data;
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 ||
          this.isTokenError({
            status: error.response?.status ?? 0,
            data: (error.response?.data as Record<string, unknown>) ?? null,
          }))
      ) {
        this.logger.warn(`[${baseOrigin}] Token expirado/inválido, renovando`);
        await this.renovarToken(baseOrigin);

        if (!state.token) {
          throw new InternalServerErrorException(
            'Token não disponível após renovação',
          );
        }

        const retry = await request(state.token);
        return retry.data;
      }

      if (axios.isAxiosError(error)) {
        this.logger.error(
          `[${baseOrigin}] Erro HTTP ${error.response?.status ?? 'sem resposta'}`,
        );
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // M7 API calls
  // ---------------------------------------------------------------------------

  private async consultarVeiculo(
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<M7ConsultaVeiculoResponse> {
    const url = `${process.env.M7_API_BASE_URL}api/veiculos/consulta`;
    this.logger.debug(
      `[${baseOrigin}] consultarVeiculo → POST ${url} | body: ${JSON.stringify({ cnpj, chassi })}`,
    );
    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.post(
          url,
          { cnpj, chassi },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: M7_REQUEST_TIMEOUT,
          },
        ),
      );
      this.logger.debug(
        `[${baseOrigin}] consultarVeiculo ← resposta: ${JSON.stringify(data)}`,
      );
      return data as M7ConsultaVeiculoResponse;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      const status = axios.isAxiosError(error) ? error.response?.status : 'N/A';
      const body = axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data)
        : '';
      this.logger.error(
        `[${baseOrigin}] consultarVeiculo ERRO: status=${status} body=${body} msg=${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new BadGatewayException('Falha ao consultar veículo na API M7');
    }
  }

  private async buscarTrajetos(
    codigoVeiculo: number,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<M7TrajetosApiResponse> {
    const params = new URLSearchParams({
      data_inicio: toDateTimeParam(dataInicial),
      data_fim: toDateTimeParam(dataFinal),
    });
    const endpoint = `${process.env.M7_API_BASE_URL}api/monitorado/${codigoVeiculo}/trajetos?${params.toString()}`;
    this.logger.debug(`[${baseOrigin}] buscarTrajetos → GET ${endpoint}`);

    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );
      this.logger.debug(
        `[${baseOrigin}] buscarTrajetos ← trajetos recebidos: ${(data as M7TrajetosApiResponse)?.trajetos?.length ?? 0}`,
      );
      return data as M7TrajetosApiResponse;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      const status = axios.isAxiosError(error) ? error.response?.status : 'N/A';
      const body = axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data)
        : '';
      this.logger.error(
        `[${baseOrigin}] buscarTrajetos ERRO: status=${status} body=${body} msg=${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new BadGatewayException('Falha ao buscar trajetos na API M7');
    }
  }

  private async buscarHistoricoGps(
    codigoVeiculo: number,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<M7HistoricoApiResponse> {
    const endpoint = `${process.env.M7_API_BASE_URL}api/historico/${dataInicial}/${dataFinal}/${codigoVeiculo}`;

    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );
      return data as M7HistoricoApiResponse;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] buscarHistoricoGps ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new BadGatewayException('Falha ao buscar histórico GPS na API M7');
    }
  }

  // ---------------------------------------------------------------------------
  // Public orchestrators
  // ---------------------------------------------------------------------------

  async gerarPdf(
    cnpj: string,
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<Buffer> {
    const veiculoData = await this.consultarVeiculo(cnpj, chassi, baseOrigin);

    if (!veiculoData?.veiculo?.codigo) {
      throw new NotFoundException('Veículo não encontrado na plataforma M7');
    }

    const { codigo, placa, chassi: chassiM7 } = veiculoData.veiculo;

    const trajetosRaw = await this.buscarTrajetos(
      codigo,
      dataInicial,
      dataFinal,
      baseOrigin,
    );
    const trajetos = filtrarTrajetos(
      Array.isArray(trajetosRaw?.trajetos) ? trajetosRaw.trajetos : [],
    );

    const distanciaTotal = trajetos.reduce(
      (acc, t) => acc + t.distanciaMetros,
      0,
    );
    const velocidadeMaxima = trajetos.reduce(
      (max, t) => Math.max(max, t.velocidadeMaxima),
      0,
    );

    const dadosPdf: HistoricoM7PdfDataDto = {
      veiculo: { codigo, placa, chassi: chassiM7 },
      periodo: { dataInicial, dataFinal },
      resumo: {
        totalTrajetos: trajetos.length,
        distanciaTotalMetros: distanciaTotal,
        velocidadeMaxima,
      },
      trajetos,
    };

    return this.pdfService.gerarPdf(dadosPdf);
  }

  async obterResumo(
    cnpj: string,
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoM7ResumoResponseDto> {
    const veiculoData = await this.consultarVeiculo(cnpj, chassi, baseOrigin);

    if (!veiculoData?.veiculo?.codigo) {
      throw new NotFoundException('Veículo não encontrado na plataforma M7');
    }

    const { codigo, placa, chassi: chassiM7 } = veiculoData.veiculo;

    const trajetosRaw = await this.buscarTrajetos(
      codigo,
      dataInicial,
      dataFinal,
      baseOrigin,
    );
    const rawList = Array.isArray(trajetosRaw?.trajetos)
      ? trajetosRaw.trajetos
      : [];

    this.logger.debug(
      `[${baseOrigin}] obterResumo: ${rawList.length} registros brutos recebidos`,
    );

    const parseNum = (v: number | string | undefined): number => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };

    const isZeroTempo = (tempo: string | undefined): boolean => {
      if (!tempo) return true;
      return /^0{1,2}:0{1,2}:0{1,2}$/.test(tempo.trim());
    };

    // Modelo de estados: PARADO → VIAGEM → PARADO
    // Origem vem do PARADO anterior, destino vem da VIAGEM.
    const viagens: ViagemM7Dto[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const atual = rawList[i];
      if (atual.tipo !== 'VIAGEM') continue;

      const distanciaKm = parseNum(atual.distancia);
      const tempoMovimento = atual.tempo_movimento ?? '00:00:00';

      // Ignorar viagens inválidas / ruído de telemetria
      if (distanciaKm === 0 || isZeroTempo(tempoMovimento)) continue;

      // Encontrar o PARADO mais próximo anterior
      let origemEndereco = '';
      for (let j = i - 1; j >= 0; j--) {
        if (rawList[j].tipo === 'PARADO') {
          origemEndereco = String(rawList[j].destino ?? '');
          break;
        }
      }

      viagens.push({
        origem: origemEndereco,
        saida: String(atual.data_inicio ?? ''),
        destino: String(atual.destino ?? ''),
        chegada: String(atual.data_fim ?? ''),
        distanciaKm,
        tempoMovimento,
        velocidadeMaxima: parseNum(atual.velocidade_maxima),
      });
    }

    this.logger.debug(
      `[${baseOrigin}] obterResumo: ${viagens.length} viagens válidas mapeadas`,
    );

    // Agrupar por data de saída
    const porData = new Map<string, DiaM7ResumoDto>();
    for (const viagem of viagens) {
      const data: string = viagem.saida.slice(0, 10);
      if (!porData.has(data)) {
        porData.set(data, {
          data,
          viagens: [] as ViagemM7Dto[],
          distanciaTotalKm: 0,
        });
      }
      const dia = porData.get(data)!;
      dia.viagens.push(viagem);
      dia.distanciaTotalKm =
        Math.round((dia.distanciaTotalKm + viagem.distanciaKm) * 100) / 100;
    }

    const dias = Array.from(porData.values()).sort((a, b) =>
      a.data.localeCompare(b.data),
    );

    const distanciaTotalKm =
      Math.round(viagens.reduce((acc, v) => acc + v.distanciaKm, 0) * 100) /
      100;
    const velocidadeMaxima = viagens.reduce<number>(
      (max, v) => Math.max(max, v.velocidadeMaxima as number),
      0,
    );

    return {
      veiculo: { codigo, placa, chassi: chassiM7 },
      periodo: { dataInicial, dataFinal },
      resumo: {
        diasComDados: dias.length,
        totalViagens: viagens.length,
        distanciaTotalKm,
        velocidadeMaxima,
      },
      dias,
    };
  }

  async obterRotas(
    cnpj: string,
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoM7RotasResponseDto> {
    const veiculoData = await this.consultarVeiculo(cnpj, chassi, baseOrigin);

    if (!veiculoData?.veiculo?.codigo) {
      throw new NotFoundException('Veículo não encontrado na plataforma M7');
    }

    const { codigo, placa, chassi: chassiM7 } = veiculoData.veiculo;

    const historicoRaw = await this.buscarHistoricoGps(
      codigo,
      dataInicial,
      dataFinal,
      baseOrigin,
    );
    const pontosRaw = Array.isArray(historicoRaw?.historico)
      ? historicoRaw.historico
      : [];
    const pontos = sanitizarPontosGps(pontosRaw);

    return {
      veiculo: { codigo, placa, chassi: chassiM7 },
      periodo: { dataInicial, dataFinal },
      totalPontos: pontos.length,
      pontos,
    };
  }
}
