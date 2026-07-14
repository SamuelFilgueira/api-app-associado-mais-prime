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
  HistoricoM7ContestacaoPdfDataDto,
  HistoricoM7PdfDataDto,
  HistoricoM7ResumoResponseDto,
  HistoricoM7RotasResponseDto,
} from '../dto/historico-m7-response.dto';
import {
  filtrarHistoricoPorPeriodo,
  filtrarTrajetosPorPeriodo,
  M7BuscaPeriodoOptions,
  shiftIsoDate,
  toDateTimeParam,
  validarPeriodoMaximoContestacao,
} from '../helpers/historico-m7-utils.helper';
import { sanitizarPontosGps } from '../helpers/m7-gps-sanitizer.helper';
import { HistoricoPdfM7Service } from '../pdf/historico-pdf-m7.service';
import { M7ReverseGeocodeService } from './m7-reverse-geocode.service';
import { M7ViagensBuilderService } from './m7-viagens-builder.service';

const M7_REQUEST_TIMEOUT = 50_000;
const MAX_LOG_PAYLOAD_LENGTH = 1_500;

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

@Injectable()
export class HistoricoM7Service {
  private readonly logger = new Logger(HistoricoM7Service.name);

  private stringifyForLog(data: unknown): string {
    const serialized = JSON.stringify(data);

    if (!serialized) {
      return '(vazio)';
    }

    if (serialized.length <= MAX_LOG_PAYLOAD_LENGTH) {
      return serialized;
    }

    return `${serialized.slice(0, MAX_LOG_PAYLOAD_LENGTH)}... [truncated ${serialized.length - MAX_LOG_PAYLOAD_LENGTH} chars]`;
  }

  private readonly tokenState: Record<BaseOrigin, TokenState> = {
    MAIS_PRIME: { token: null, tokenExpires: null, tokenRenewalPromise: null },
    MAIS_PRIME_RS: {
      token: null,
      tokenExpires: null,
      tokenRenewalPromise: null,
    },
  };

  constructor(
    private readonly pdfService: HistoricoPdfM7Service,
    private readonly reverseGeocodeService: M7ReverseGeocodeService,
    private readonly viagensBuilderService: M7ViagensBuilderService,
  ) {
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
    options?: M7BuscaPeriodoOptions,
  ): Promise<M7TrajetosApiResponse> {
    const expandirDataFinal = options?.expandirDataFinal ?? true;
    const filtrarPeriodoSelecionado =
      options?.filtrarPeriodoSelecionado ?? true;
    const dataFinalConsulta = expandirDataFinal
      ? shiftIsoDate(dataFinal, 1)
      : dataFinal;

    const endpoint = `${process.env.M7_API_BASE_URL}api/monitorado/${codigoVeiculo}/trajetos?data_inicio=${toDateTimeParam(dataInicial)}&data_fim=${toDateTimeParam(dataFinalConsulta)}`;
    this.logger.debug(`[${baseOrigin}] buscarTrajetos → GET ${endpoint}`);

    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );
      this.logger.debug(
        `[${baseOrigin}] buscarTrajetos ← resposta: ${this.stringifyForLog(data)}`,
      );

      const resposta = data as M7TrajetosApiResponse;
      const trajetosOriginais = Array.isArray(resposta?.trajetos)
        ? resposta.trajetos
        : [];

      if (!filtrarPeriodoSelecionado) {
        return resposta;
      }

      const trajetosFiltrados = filtrarTrajetosPorPeriodo(
        trajetosOriginais,
        dataInicial,
        dataFinal,
      );

      if (trajetosFiltrados.length !== trajetosOriginais.length) {
        this.logger.debug(
          `[${baseOrigin}] buscarTrajetos filtro período aplicado: ${trajetosOriginais.length} → ${trajetosFiltrados.length} (janela UI ${dataInicial}..${dataFinal})`,
        );
      }

      return {
        ...resposta,
        trajetos: trajetosFiltrados,
      };
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
    options?: M7BuscaPeriodoOptions,
  ): Promise<M7HistoricoApiResponse> {
    const expandirDataFinal = options?.expandirDataFinal ?? true;
    const filtrarPeriodoSelecionado =
      options?.filtrarPeriodoSelecionado ?? true;
    const dataFinalConsulta = expandirDataFinal
      ? shiftIsoDate(dataFinal, 1)
      : dataFinal;

    const endpoint = `${process.env.M7_API_BASE_URL}api/historico/${dataInicial}/${dataFinalConsulta}/${codigoVeiculo}`;
    this.logger.debug(`[${baseOrigin}] buscarHistoricoGps → GET ${endpoint}`);

    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );

      this.logger.debug(
        `[${baseOrigin}] buscarHistoricoGps ← resposta: ${this.stringifyForLog(data)}`,
      );

      const resposta = data as M7HistoricoApiResponse;
      const historicoOriginal = Array.isArray(resposta?.historico)
        ? resposta.historico
        : [];

      if (!filtrarPeriodoSelecionado) {
        return resposta;
      }

      const historicoFiltrado = filtrarHistoricoPorPeriodo(
        historicoOriginal,
        dataInicial,
        dataFinal,
      );

      if (historicoFiltrado.length !== historicoOriginal.length) {
        this.logger.debug(
          `[${baseOrigin}] buscarHistoricoGps filtro período aplicado: ${historicoOriginal.length} → ${historicoFiltrado.length} (janela UI ${dataInicial}..${dataFinal})`,
        );
      }

      return {
        ...resposta,
        historico: historicoFiltrado,
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      const status = axios.isAxiosError(error) ? error.response?.status : 'N/A';
      const body = axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data)
        : '';
      this.logger.error(
        `[${baseOrigin}] buscarHistoricoGps ERRO: status=${status} body=${body} msg=${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new BadGatewayException('Falha ao buscar histórico GPS na API M7');
    }
  }

  // ---------------------------------------------------------------------------
  // Public orchestrators
  // ---------------------------------------------------------------------------

  async gerarPdfV2(
    cnpj: string,
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<Buffer> {
    this.logger.log(
      `[${baseOrigin}] [V2] gerarPdfV2 início | cnpj=${cnpj} chassi=${chassi} período=${dataInicial}..${dataFinal}`,
    );

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

    this.logger.log(
      `[${baseOrigin}] [V2] histórico recebido | pontos=${pontosRaw.length}`,
    );

    const { viagens, dias, distanciaTotalKm, velocidadeMaxima } =
      await this.viagensBuilderService.construirViagensEDiasPorHistorico(
        pontosRaw,
        baseOrigin,
      );

    if (!viagens.length) {
      this.logger.warn(
        `[${baseOrigin}] [V2] nenhuma viagem gerada após reconstrução | pontos=${pontosRaw.length} período=${dataInicial}..${dataFinal}`,
      );
    }

    const dadosPdf: HistoricoM7PdfDataDto = {
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

    this.logger.log(
      `[${baseOrigin}] [V2] gerarPdfV2 fim | dias=${dias.length} viagens=${viagens.length} distanciaTotalKm=${distanciaTotalKm} velocidadeMaxima=${velocidadeMaxima}`,
    );

    return this.pdfService.gerarPdf(dadosPdf);
  }

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
    const rawList = Array.isArray(trajetosRaw?.trajetos)
      ? trajetosRaw.trajetos
      : [];

    const parseNum = (value: number | string | undefined): number => {
      const numero = Number(value ?? 0);
      return Number.isFinite(numero) ? numero : 0;
    };

    const isZeroTempo = (tempo: string | undefined): boolean => {
      if (!tempo) return true;
      return /^0{1,2}:0{1,2}:0{1,2}$/.test(tempo.trim());
    };

    const viagens = rawList.map((item) => {
      const tipo = String(item.tipo ?? '').toUpperCase();
      const tempoMovimentoBruto = String(item.tempo_movimento ?? '00:00:00');
      const tempoParadoBruto = String(item.tempo_parado ?? '00:00:00');
      const tempoTotalBruto = String(item.tempo_total ?? '00:00:00');

      const ehParado = tipo === 'PARADO' || isZeroTempo(tempoMovimentoBruto);

      return {
        origem: tipo || '—',
        saida: String(item.data_inicio ?? ''),
        destino: String(item.destino ?? '').trim(),
        chegada: String(item.data_fim ?? ''),
        distanciaKm: parseNum(item.distancia),
        tempoMovimento: `Total: ${tempoTotalBruto}`,
        tempoParado: `${ehParado ? 'Parado' : 'Viagem'}: ${
          ehParado ? tempoParadoBruto : tempoMovimentoBruto
        }`,
        tempoTotal: '',
        velocidadeMaxima: parseNum(item.velocidade_maxima),
      };
    });

    const porData = new Map<string, (typeof viagens)[number][]>();
    for (const viagem of viagens) {
      const dataBase = (viagem.saida || viagem.chegada || '').slice(0, 10);
      const data = /^\d{4}-\d{2}-\d{2}$/.test(dataBase)
        ? dataBase
        : 'Sem data';
      if (!porData.has(data)) {
        porData.set(data, []);
      }
      porData.get(data)!.push(viagem);
    }

    const diasParaPdf = Array.from(porData.entries())
      .map(([data, viagensDia]) => ({
        data,
        viagens: viagensDia,
        distanciaTotalKm:
          Math.round(
            viagensDia.reduce((acc, viagem) => acc + viagem.distanciaKm, 0) *
              100,
          ) / 100,
      }))
      .sort((a, b) => a.data.localeCompare(b.data));

    const distanciaTotalKm =
      Math.round(viagens.reduce((acc, viagem) => acc + viagem.distanciaKm, 0) * 100) /
      100;
    const velocidadeMaxima = viagens.reduce(
      (max, viagem) => Math.max(max, viagem.velocidadeMaxima),
      0,
    );

    const dadosPdf: HistoricoM7PdfDataDto = {
      veiculo: { codigo, placa, chassi: chassiM7 },
      periodo: { dataInicial, dataFinal },
      resumo: {
        diasComDados: diasParaPdf.length,
        totalViagens: viagens.length,
        distanciaTotalKm,
        velocidadeMaxima,
      },
      dias: diasParaPdf,
    };

    return this.pdfService.gerarPdf(dadosPdf);
  }

  async gerarPdfContestacao(
    cnpj: string,
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<Buffer> {
    validarPeriodoMaximoContestacao(dataInicial, dataFinal);

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

    this.logger.debug(
      `[${baseOrigin}] gerarPdfContestacao: ${pontosRaw.length} registros brutos recebidos`,
    );

    const pontos = await this.reverseGeocodeService.montarPontosContestacao(
      pontosRaw,
      baseOrigin,
    );

    const dadosPdf: HistoricoM7ContestacaoPdfDataDto = {
      veiculo: { codigo, placa, chassi: chassiM7 },
      periodo: { dataInicial, dataFinal },
      pontos,
    };

    return this.pdfService.gerarPdfContestacao(dadosPdf);
  }

  async gerarPdfContestacaoV2(
    cnpj: string,
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
  ): Promise<Buffer> {
    validarPeriodoMaximoContestacao(dataInicial, dataFinal);

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

    this.logger.log(
      `[${baseOrigin}] gerarPdfContestacaoV2: ${pontosRaw.length} pontos recebidos | período=${dataInicial}..${dataFinal}`,
    );

    const pontos = await this.reverseGeocodeService.montarPontosContestacao(
      pontosRaw,
      baseOrigin,
    );

    this.logger.log(
      `[${baseOrigin}] gerarPdfContestacaoV2: ${pontos.length} pontos geocodificados`,
    );

    const dadosPdf: HistoricoM7ContestacaoPdfDataDto = {
      veiculo: { codigo, placa, chassi: chassiM7 },
      periodo: { dataInicial, dataFinal },
      pontos,
    };

    return this.pdfService.gerarPdfContestacaoV2(dadosPdf);
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

    const { viagens, dias, distanciaTotalKm, velocidadeMaxima } =
      this.viagensBuilderService.construirViagensEDias(rawList);

    this.logger.debug(
      `[${baseOrigin}] obterResumo: ${viagens.length} viagens válidas mapeadas`,
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
