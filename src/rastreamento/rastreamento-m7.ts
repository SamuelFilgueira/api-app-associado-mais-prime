import {
  BadGatewayException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import puppeteer from 'puppeteer';
import { BaseOrigin } from '../shared/token-resolver.service';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Timeout padrão para chamadas HTTP à API M7 (em ms) */
const M7_REQUEST_TIMEOUT = 15_000;

/**
 * Mapeamento de credenciais por base de origem.
 * Cada base possui variáveis de ambiente distintas para token e código.
 */
const M7_CREDENTIALS: Record<
  BaseOrigin,
  { tokenEnvVar: string; codigoEnvVar: string }
> = {
  MAIS_PRIME: { tokenEnvVar: 'MO7_TOKEN', codigoEnvVar: 'M07_CODIGO' },
  MAIS_PRIME_RS: { tokenEnvVar: 'MO7_TOKEN_RS', codigoEnvVar: 'M07_CODIGO_RS' },
};

// ---------------------------------------------------------------------------
// Tipos e interfaces
// ---------------------------------------------------------------------------

/** Estado interno do token de autenticação para uma base de origem. */
type TokenState = {
  token: string | null;
  tokenExpires: number | null;
  /** Promise em andamento de renovação, usada como mutex. */
  tokenRenewalPromise: Promise<void> | null;
};

/** Resposta da consulta de última posição do veículo na API M7. */
export interface UltimaPosicaoM7Response {
  monitorado: number;
  data_gps: string;
  latitude: string;
  longitude: string;
  velocidade: number;
  ignicao: boolean;
  cidade: string;
  marca: string;
  modelo: string;
  identificador: string;
}

/**
 * Resposta do endpoint de âncora/ignição da API M7.
 * Retorna os dados atualizados em caso de sucesso ou um objeto de erro.
 */
export type AncoraM7Response =
  | {
      mensagem: string;
      monitorado: number;
      ancora_ativa: number;
      evt_ign: number;
      evg_ign_exec: number;
      ancora_lat: number;
      ancora_lng: number;
    }
  | {
      erro: string;
    };

/** Estado normalizado do evento padrão (âncora + ignição) de um veículo. */
export interface EventoPadraoM7Response {
  ancoraAtiva: boolean;
  evtIgn: boolean;
}

interface HistoricoM7RawItem {
  codigo_posicao: number;
  identificador: string;
  monitorado: number;
  data_gps: string;
  cidade: string;
  latitude: number | string;
  longitude: number | string;
  tensao?: string | null;
  bateria?: string | null;
}

interface HistoricoM7ApiResponse {
  historico?: HistoricoM7RawItem[];
}

interface HistoricoM7Normalizado {
  codigo_posicao: number;
  identificador: string;
  data_gps: string;
  cidade: string;
  latitude: number;
  longitude: number;
  tensao: string;
  bateria: string;
}

interface RelatorioHistoricoPdfData {
  placa: string;
  periodo: string;
  registros: Array<{
    data: string;
    endereco: string;
    cidade: string;
    identificador: string;
  }>;
}

// ---------------------------------------------------------------------------
// Classe principal
// ---------------------------------------------------------------------------

export class RastreamentoM7 {
  private readonly logger = new Logger(RastreamentoM7.name);

  /** Cache em memória para endereços por coordenada (lat,lng). */
  private readonly geocodeCache = new Map<string, string>();

  /** Limite global de geocoding por requisição de PDF. */
  private static readonly MAX_GEOCODING = 8;

  /** Intervalo de segurança entre chamadas sequenciais ao geocoding (ms). */
  private static readonly GEOCODING_DELAY_MS = 1100;

  // -------------------------------------------------------------------------
  // Estado interno
  // -------------------------------------------------------------------------

  /** Estado de token por base de origem. */
  private readonly tokenState: Record<BaseOrigin, TokenState> = {
    MAIS_PRIME: { token: null, tokenExpires: null, tokenRenewalPromise: null },
    MAIS_PRIME_RS: {
      token: null,
      tokenExpires: null,
      tokenRenewalPromise: null,
    },
  };

  // -------------------------------------------------------------------------
  // Inicialização
  // -------------------------------------------------------------------------

  constructor() {
    // Obtém tokens para todas as bases ao iniciar a instância
    void this.renovarToken('MAIS_PRIME');
    void this.renovarToken('MAIS_PRIME_RS');

    // Renova tokens a cada 30 minutos de forma contínua.
    // .unref() evita que o intervalo bloqueie o shutdown da aplicação.
    setInterval(() => {
      this.renovarToken('MAIS_PRIME').catch(() => {});
      this.renovarToken('MAIS_PRIME_RS').catch(() => {});
    }, 1800000).unref();
  }

  // -------------------------------------------------------------------------
  // Gerenciamento de token
  // -------------------------------------------------------------------------

  /**
   * Renova o token M7 com mutex — chamadas concorrentes reutilizam
   * a mesma promise de renovação, evitando múltiplos logins simultâneos.
   */
  async renovarToken(baseOrigin: BaseOrigin = 'MAIS_PRIME') {
    const state = this.tokenState[baseOrigin];

    // Se já há uma renovação em andamento, aguarda e reutiliza o resultado
    if (state.tokenRenewalPromise) {
      await state.tokenRenewalPromise;
      return {
        token: state.token,
        expires_in: state.tokenExpires,
      };
    }

    state.tokenRenewalPromise = this.executeRenovarToken(baseOrigin);

    try {
      await state.tokenRenewalPromise;
      return {
        token: state.token,
        expires_in: state.tokenExpires,
      };
    } finally {
      state.tokenRenewalPromise = null;
    }
  }

  /**
   * Executa efetivamente a chamada de login na API M7 e atualiza o estado
   * interno do token para a base informada.
   */
  private async executeRenovarToken(baseOrigin: BaseOrigin): Promise<void> {
    const { tokenEnvVar, codigoEnvVar } = M7_CREDENTIALS[baseOrigin];
    const apiM7Token = process.env[tokenEnvVar];
    const codigo = process.env[codigoEnvVar];

    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL}login`,
        {
          codigo,
          api_m7_token: apiM7Token,
        },
        { timeout: M7_REQUEST_TIMEOUT },
      );

      if (response.data && response.data.sucesso) {
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

  /**
   * Detecta se a resposta indica token expirado ou inválido,
   * tanto por status HTTP 401 quanto por mensagem no body.
   */
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

  /**
   * Wrapper genérico: executa o request fornecido e, em caso de token
   * inválido ou expirado, renova e repete a chamada uma única vez.
   *
   * Axios lança AxiosError para respostas HTTP >= 400 (incluindo 401),
   * por isso é necessário capturar a exceção além de checar o body.
   */
  private async executarComReautenticacao<T>(
    baseOrigin: BaseOrigin,
    request: (token: string) => Promise<{ status: number; data: T }>,
  ): Promise<T> {
    const state = this.tokenState[baseOrigin];

    if (!state.token) {
      this.logger.error(
        `[${baseOrigin}] executarComReautenticacao - Token não disponível`,
      );
      throw new InternalServerErrorException('Token não disponível');
    }

    try {
      const response = await request(state.token);
      return response.data;
    } catch (error) {
      // Verifica se o erro é de autenticação e tenta renovar o token
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
          this.logger.error(
            `[${baseOrigin}] Token ainda indisponível após renovação`,
          );
          throw new InternalServerErrorException(
            'Token não disponível após renovação',
          );
        }

        // Retry único com o token renovado
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

  // -------------------------------------------------------------------------
  // Utilitários internos
  // -------------------------------------------------------------------------

  /** Mascara parcialmente um segredo para exibição segura em logs. */
  private maskSecret(value?: string | null): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  // -------------------------------------------------------------------------
  // Consultas de veículo
  // -------------------------------------------------------------------------

  /**
   * Consulta a última posição conhecida do veículo na API M7.
   */
  async ultimaPosicaoM7(
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<UltimaPosicaoM7Response> {
    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.post(
          `${process.env.M7_API_BASE_URL}api/veiculos/ultima-posicao`,
          { cnpj, chassi },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: M7_REQUEST_TIMEOUT,
          },
        ),
      );
      const result = this.mapearUltimaPosicaoM7(
        data as Record<string, unknown>,
      );
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] ultimaPosicaoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao consultar última posição do veículo',
      );
    }
  }

  /**
   * Busca o estado atual do veículo na API M7 (âncora + ignição).
   * Utilizado como fallback quando o banco não possui o estado registrado.
   */
  async getEventoPadraoM7(
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<EventoPadraoM7Response> {
    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(`${process.env.M7_API_BASE_URL}api/veiculos/evento-padrao`, {
          params: { cnpj, chassi, scope: 'cliente' },
          headers: { Authorization: `Bearer ${token}` },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );
      const evento = ((data as Record<string, unknown>).evento ?? {}) as Record<
        string,
        unknown
      >;
      const result = {
        ancoraAtiva: Boolean(evento.ancora),
        evtIgn: Boolean(evento.ignicao_ligada),
      };
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] getEventoPadraoM7 ERRO: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      throw new InternalServerErrorException(
        'Erro ao buscar estado atual do veículo na API M7',
      );
    }
  }

  /**
   * Método solicitado para geração de relatório PDF do histórico.
   * Mantém assinatura simples e usa a base padrão por compatibilidade.
   */
  async gerarRelatorioHistoricoPDF(
    dataInicial: string,
    dataFinal: string,
    placa: string,
  ): Promise<Buffer> {
    return this.gerarRelatorioHistoricoPDFPorBase(
      dataInicial,
      dataFinal,
      placa,
      'MAIS_PRIME',
    );
  }

  /**
   * Gera relatório PDF do histórico M7 para uma base específica.
   */
  async gerarRelatorioHistoricoPDFPorBase(
    dataInicial: string,
    dataFinal: string,
    placa: string,
    baseOrigin: BaseOrigin,
  ): Promise<Buffer> {
    const historico = await this.fetchHistorico(
      dataInicial,
      dataFinal,
      placa,
      baseOrigin,
    );

    const dadosNormalizados = this.normalizarDados(historico);

    const dadosReduzidos = this.reduzirPontosPorTempoEDistancia(dadosNormalizados);

    const dadosPdf = await this.estruturarDadosParaPDF(
      placa,
      dataInicial,
      dataFinal,
      dadosReduzidos,
    );

    return this.gerarPDF(dadosPdf);
  }

  // -------------------------------------------------------------------------
  // Comandos de veículo (âncora / ignição)
  // -------------------------------------------------------------------------

  /**
   * Envia o payload completo (âncora + ignição) para o endpoint da API M7.
   * Sempre envia ambos os campos para evitar reset acidental de um pelo outro.
   */
  private async _enviarComandoVeiculo(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    evtIgn: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    const payload = {
      cnpj,
      chassi,
      ancora_ativa: ancoraAtiva,
      evt_ign: evtIgn,
      Envio_mult: true,
    };
    const data = await this.executarComReautenticacao(baseOrigin, (token) =>
      axios.post(`${process.env.M7_API_BASE_URL}api/veiculos/ancora`, payload, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: M7_REQUEST_TIMEOUT,
      }),
    );
    const result = this.mapearAncoraM7(data as Record<string, unknown>);
    return result;
  }

  /**
   * Ativa ou desativa a âncora do veículo.
   * O estado de ignição atual deve ser informado para evitar reset acidental.
   */
  async ancoraM7(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    evtIgn: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    try {
      const result = await this._enviarComandoVeiculo(
        cnpj,
        chassi,
        ancoraAtiva,
        evtIgn,
        baseOrigin,
      );
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] ancoraM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException('Erro ao atualizar âncora');
    }
  }

  /**
   * Ativa ou desativa a ignição do veículo.
   * O estado de âncora atual deve ser informado para evitar reset acidental.
   */
  async ignicaoM7(
    cnpj: string,
    chassi: string,
    evtIgn: boolean,
    ancoraAtiva: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    try {
      const result = await this._enviarComandoVeiculo(
        cnpj,
        chassi,
        ancoraAtiva,
        evtIgn,
        baseOrigin,
      );
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] ignicaoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException('Erro ao atualizar ignição');
    }
  }

  // -------------------------------------------------------------------------
  // Histórico M7 (consulta + enriquecimento + PDF)
  // -------------------------------------------------------------------------

  /**
   * Consulta a API externa de histórico M7 usando autenticação já existente.
   */
  private async fetchHistorico(
    dataInicial: string,
    dataFinal: string,
    placa: string,
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoM7RawItem[]> {
    const endpoint = `${process.env.M7_API_BASE_URL}api/historico/${dataInicial}/${dataFinal}/${encodeURIComponent(
      placa,
    )}`;

    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(endpoint, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );

      const response = data as HistoricoM7ApiResponse;
      return Array.isArray(response.historico) ? response.historico : [];
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] fetchHistorico ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new BadGatewayException(
        'Falha ao consultar API externa de histórico M7',
      );
    }
  }

  /**
   * Normaliza payload bruto do histórico para estrutura tipada e estável.
   */
  private normalizarDados(
    historico: HistoricoM7RawItem[],
  ): HistoricoM7Normalizado[] {
    return historico.map((item) => ({
      codigo_posicao: Number(item.codigo_posicao),
      identificador: String(item.identificador ?? ''),
      data_gps: String(item.data_gps ?? ''),
      cidade: String(item.cidade ?? ''),
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      tensao: String(item.tensao ?? '').trim(),
      bateria: String(item.bateria ?? '').trim(),
    }));
  }

  /** Aguarda um tempo em ms. */
  private async aguardar(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Normaliza coordenadas para reduzir cardinalidade de pontos próximos.
   * Ex.: -22.973696,-43.370782 -> -22.974,-43.371
   */
  private normalizarCoord(latitude: number, longitude: number): string {
    return `${latitude.toFixed(1)},${longitude.toFixed(1)}`;
  }

  /** Monta endereço aproximado sem depender de geocoding */
  private montarEnderecoBase(item: HistoricoM7Normalizado): string {
    return `${item.cidade} (aprox. ${item.latitude.toFixed(2)}, ${item.longitude.toFixed(2)})`;
  }

    private calcularDistancia(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // km
  }

  private reduzirPontosPorTempoEDistancia(
    historico: HistoricoM7Normalizado[],
  ): HistoricoM7Normalizado[] {
    const resultado: HistoricoM7Normalizado[] = [];

    let ultimo: HistoricoM7Normalizado | null = null;

    for (const item of historico) {
      if (!ultimo) {
        resultado.push(item);
        ultimo = item;
        continue;
      }

      const distancia = this.calcularDistancia(
        ultimo.latitude,
        ultimo.longitude,
        item.latitude,
        item.longitude,
      );

      const tempoDiff =
        new Date(item.data_gps).getTime() -
        new Date(ultimo.data_gps).getTime();

      const minutos = tempoDiff / (1000 * 60);

      if (distancia >= 0.3 || minutos >= 30) {
        resultado.push(item);
        ultimo = item;
      }
    }

    return resultado;
  }

  /**
   * Resolve endereço completo por coordenada normalizada.
   *
   * Regra obrigatória: ao receber 429, aplica fallback imediato
   * (sem retry adicional).
   */
  private async getEnderecoPorCoordenadaNormalizada(
    coordenadaNormalizada: string,
  ): Promise<string | null> {
    const cached = this.geocodeCache.get(coordenadaNormalizada);
    if (cached) {
      return cached;
    }

    const [latRaw, lngRaw] = coordenadaNormalizada.split(',');
    const latitude = Number(latRaw);
    const longitude = Number(lngRaw);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    try {
      const response = await axios.get(
        'https://nominatim.openstreetmap.org/reverse',
        {
          params: { lat: latitude, lon: longitude, format: 'jsonv2' },
          headers: { 'User-Agent': 'beneficios-api/1.0' },
          timeout: 5_000,
        },
      );

      const address = response.data.address;

      const endereco = [
        address.road,
        address.suburb,
        address.city || address.town,
        address.state
      ]
      .filter(Boolean)
      .join(', ');

      this.geocodeCache.set(coordenadaNormalizada, endereco);
      return endereco;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        this.logger.warn(
          `Reverse geocoding 429 para ${coordenadaNormalizada} (sem retry, fallback imediato)`,
        );
        return null;
      }

      this.logger.warn(
        `Reverse geocoding falhou para ${coordenadaNormalizada}: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Monta a estrutura final usada para renderização do relatório em PDF.
   *
   * Fluxo:
   * 1) Deduplica coordenadas (exatas e normalizadas)
   * 2) Limita geocoding para no máximo MAX_GEOCODING por requisição
   * 3) Executa geocoding sequencial controlado (sem retry em 429)
   * 3) Monta registros enriquecidos localmente sem novas chamadas externas
   */
  private async estruturarDadosParaPDF(
    placa: string,
    dataInicial: string,
    dataFinal: string,
    historico: HistoricoM7Normalizado[],
  ): Promise<RelatorioHistoricoPdfData> {
    const coordenadasUnicasAntes = Array.from(
      new Set(historico.map((item) => `${item.latitude},${item.longitude}`)),
    );

    const coordenadasNormalizadasUnicas = Array.from(
      new Set(
        historico.map((item) =>
          this.normalizarCoord(item.latitude, item.longitude),
        ),
      ),
    );

    const cacheEndereco = new Map<string, string>();
    for (const coordenada of coordenadasNormalizadasUnicas) {
      const cached = this.geocodeCache.get(coordenada);
      if (cached) {
        cacheEndereco.set(coordenada, cached);
      }
    }

    const fallbackPorCoordenada = new Map<string, string>();
    for (const item of historico) {
      const chave = this.normalizarCoord(item.latitude, item.longitude);
      if (!fallbackPorCoordenada.has(chave)) {
        fallbackPorCoordenada.set(
          chave,
          item.cidade || 'Endereço não disponível',
        );
      }
    }

    const coordenadasPendentes = coordenadasNormalizadasUnicas.filter(
      (coord) => !cacheEndereco.has(coord),
    );

    const coordenadasParaGeocoding = coordenadasPendentes.slice(
      0,
      RastreamentoM7.MAX_GEOCODING,
    );
    const coordenadasComFallbackDireto = coordenadasPendentes.slice(
      RastreamentoM7.MAX_GEOCODING,
    );

    let geocodingExecutados = 0;
    let falhas = 0;

    for (const coordenada of coordenadasParaGeocoding) {
      geocodingExecutados += 1;

      const endereco =
        await this.getEnderecoPorCoordenadaNormalizada(coordenada);

      if (endereco) {
        cacheEndereco.set(coordenada, endereco);
      } else {
        falhas += 1;
        cacheEndereco.set(
          coordenada,
          fallbackPorCoordenada.get(coordenada) || 'Endereço não disponível',
        );
      }

      await this.aguardar(RastreamentoM7.GEOCODING_DELAY_MS);
    }

    for (const coordenada of coordenadasComFallbackDireto) {
      cacheEndereco.set(
        coordenada,
        fallbackPorCoordenada.get(coordenada) || 'Endereço não disponível',
      );
    }

    const cacheHits =
      coordenadasNormalizadasUnicas.length - coordenadasPendentes.length;

    this.logger.log(
      `[Historico PDF] totais=${historico.length} unicasAntes=${coordenadasUnicasAntes.length} unicasNormalizadas=${coordenadasNormalizadasUnicas.length} geocodingExecutados=${geocodingExecutados} cacheHits=${cacheHits} falhas=${falhas}`,
    );

    const registros = historico.map((item) => {
      const chave = this.normalizarCoord(item.latitude, item.longitude);
      const endereco = cacheEndereco.get(chave) || this.montarEnderecoBase(item);

      return {
        data: item.data_gps,
        endereco,
        cidade: item.cidade,
        identificador: item.identificador,
      };
    });

    return {
      placa,
      periodo: `${this.formatarDataParaBR(dataInicial)} - ${this.formatarDataParaBR(
        dataFinal,
      )}`,
      registros,
    };
  }

  /**
   * Gera PDF em memória com Puppeteer para retorno direto ao frontend.
   */
  private async gerarPDF(data: RelatorioHistoricoPdfData): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      const html = this.gerarHtmlRelatorio(data);
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '20px',
          right: '20px',
          bottom: '20px',
          left: '20px',
        },
      });

      return Buffer.from(pdf);
    } catch (error) {
      this.logger.error(
        `Erro ao gerar PDF de histórico: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      throw new InternalServerErrorException('Erro ao gerar PDF de histórico');
    } finally {
      await browser.close();
    }
  }

  /**
   * Renderiza HTML do relatório com tabela de registros e cabeçalho.
   */
  private gerarHtmlRelatorio(data: RelatorioHistoricoPdfData): string {
    const linhas = data.registros
      .map(
        (registro) => `
          <tr>
            <td>${this.escapeHtml(registro.identificador)}</td>
            <td>${this.escapeHtml(registro.cidade)}</td>
            <td>${this.escapeHtml(registro.endereco)}</td>
            <td>${this.escapeHtml(registro.data)}</td>
          </tr>
        `,
      )
      .join('');

    const semDados = `
      <tr>
        <td colspan="4" class="empty">Nenhum registro encontrado para o período informado.</td>
      </tr>
    `;

    return `
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <title>Relatório Histórico M7</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              color: #1f2937;
              font-size: 12px;
            }

            h1 {
              margin: 0 0 8px;
              font-size: 20px;
            }

            .meta {
              margin-bottom: 16px;
            }

            .meta p {
              margin: 2px 0;
            }

            table {
              width: 100%;
              border-collapse: collapse;
            }

            th,
            td {
              border: 1px solid #d1d5db;
              padding: 8px;
              text-align: left;
              vertical-align: top;
            }

            th {
              background: #f3f4f6;
              font-weight: 700;
            }

            .empty {
              text-align: center;
              color: #6b7280;
              font-style: italic;
            }
          </style>
        </head>
        <body>
          <h1>Relatório Histórico de Rastreamento</h1>
          <div class="meta">
            <p><strong>Placa:</strong> ${this.escapeHtml(data.placa)}</p>
            <p><strong>Período:</strong> ${this.escapeHtml(data.periodo)}</p>
          </div>
          <table>
            <thead>
              <tr>
                <th>Placa</th>
                <th>Cidade</th>
                <th>Endereço completo</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              ${data.registros.length > 0 ? linhas : semDados}
            </tbody>
          </table>
        </body>
      </html>
    `;
  }

  /** Escapa conteúdo textual para evitar quebra de HTML no relatório. */
  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /** Converte yyyy-mm-dd para dd/mm/yyyy. */
  private formatarDataParaBR(data: string): string {
    const [ano, mes, dia] = data.split('-');
    if (!ano || !mes || !dia) {
      return data;
    }
    return `${dia}/${mes}/${ano}`;
  }

  // -------------------------------------------------------------------------
  // Mapeamento de respostas da API M7
  // -------------------------------------------------------------------------

  /**
   * Converte o payload bruto da API M7 para o formato tipado de última posição.
   */
  private mapearUltimaPosicaoM7(
    data: Record<string, unknown>,
  ): UltimaPosicaoM7Response {
    const ultimaPosicao = (data.ultima_posicao || {}) as Record<
      string,
      unknown
    >;

    return {
      monitorado: ultimaPosicao.monitorado as number,
      data_gps: ultimaPosicao.data_gps as string,
      latitude: ultimaPosicao.latitude as string,
      longitude: ultimaPosicao.longitude as string,
      velocidade: ultimaPosicao.velocidade as number,
      ignicao: ultimaPosicao.ignicao as boolean,
      cidade: ultimaPosicao.cidade as string,
      marca: ultimaPosicao.marca as string,
      modelo: ultimaPosicao.modelo as string,
      identificador: ultimaPosicao.identificador as string,
    };
  }

  /**
   * Converte o payload bruto da API M7 para o formato tipado de âncora.
   * Retorna objeto de erro quando a API sinaliza falha no campo `erro`.
   */
  private mapearAncoraM7(data: Record<string, unknown>): AncoraM7Response {
    if (data && typeof data === 'object' && 'erro' in data) {
      return { erro: (data as { erro: string }).erro };
    }

    const ancora = data;

    return {
      mensagem: ancora.mensagem as string,
      monitorado: ancora.monitorado as number,
      ancora_ativa: ancora.ancora_ativa as number,
      evt_ign: ancora.evt_ign as number,
      evg_ign_exec: ancora.evg_ign_exec as number,
      ancora_lat: ancora.ancora_lat as number,
      ancora_lng: ancora.ancora_lng as number,
    };
  }

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  /**
   * Processa o payload recebido via webhook da API M7.
   * Valida a estrutura básica e retorna um envelope padronizado de resposta.
   */
  processarWebhook(payload: unknown): {
    sucesso: boolean;
    mensagem: string;
    dados?: unknown;
  } {
    const timestamp = new Date().toISOString();

    try {
      if (!payload) {
        return {
          sucesso: false,
          mensagem: 'Payload vazio ou inválido',
        };
      }

      if (typeof payload !== 'object') {
        return {
          sucesso: false,
          mensagem: 'Payload deve ser um objeto JSON válido',
        };
      }

      const payloadData = payload as Record<string, unknown>;
      return {
        sucesso: true,
        mensagem: 'Webhook processado com sucesso',
        dados: {
          palyload: payloadData,
          timestamp_recebimento: timestamp,
        },
      };
    } catch (error) {
      this.logger.error(
        `[M7 Webhook] Erro ao processar webhook: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
      );

      return {
        sucesso: false,
        mensagem: 'Erro ao processar webhook',
        dados: {
          erro: error instanceof Error ? error.message : 'Erro desconhecido',
          timestamp_erro: timestamp,
        },
      };
    }
  }
}
