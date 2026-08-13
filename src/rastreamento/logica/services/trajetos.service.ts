import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import {
  TrajetoResponse,
  TrajetoParada,
  TrajetoPosicao,
  TrajetoResumo,
} from '../dto/trajeto.dto';
import { TrajetoPdfLogicaService } from '../pdf/trajeto-pdf-logica.service';
import { LogicaAuthService } from './logica-auth.service';

const LOGICA_REQUEST_TIMEOUT = 15_000;
const LOGICA_TRAJETO_URL =
  'https://monitoramento.logicasolucoes.com.br/mobile/trajeto';
const LOGICA_POSICAO_URL =
  'https://monitoramento.logicasolucoes.com.br/mobile/posicao';
/** O /mobile/posicao devolve o dia inteiro (~2 MB) — timeout maior */
const LOGICA_POSICAO_TIMEOUT = 30_000;

interface LogicaListaItemPayload {
  id?: number | string;
  chassi?: string;
  placa?: string;
  marca?: string;
  modelo?: string;
  [key: string]: unknown;
}

/** Dados básicos do veículo retornados pelo /listaVeiculo da Lógica */
export interface LogicaVeiculoInfo {
  id: number;
  placa: string;
  marca: string;
  modelo: string;
}

interface LogicaListaResponsePayload {
  lista?: LogicaListaItemPayload[];
  [key: string]: unknown;
}

// Converte data no formato BR "dd/MM/yyyy HH:mm:ss" em timestamp ordenável.
// Datas inválidas vão para o fim da linha do tempo.
export function parseDataBrParaTimestamp(data: string): number {
  const match = String(data ?? '')
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) return Number.MAX_SAFE_INTEGER;

  const [, dia, mes, ano, hora, minuto, segundo] = match;
  return Date.UTC(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    Number(hora),
    Number(minuto),
    Number(segundo ?? '0'),
  );
}

// Mescla paradas e posições em uma única linha do tempo cronológica no shape
// consumido pelo PDF, deduplicando registros sobrepostos e preenchendo a
// ignição vazia com o último estado conhecido (forward-fill).
export function montarLinhaDoTempo(
  posicoes: TrajetoPosicao[],
  paradas: TrajetoParada[],
): TrajetoPosicao[] {
  const paradasComoPosicoes: TrajetoPosicao[] = paradas.map((parada) => ({
    tecladoEvento: parada.tecladoEvento,
    eventoNome: null,
    enderecoNumero: parada.enderecoNumero,
    enderecoEndereco: parada.enderecoEndereco,
    enderecoBairro: parada.enderecoBairro,
    enderecoCidade: parada.enderecoCidade,
    enderecoEstado: parada.enderecoEstado,
    endereco: parada.endereco,
    data: parada.dataInicio || parada.data,
    dataTz: 0,
    latitude: parada.latitude,
    longitude: parada.longitude,
    velocidade: parada.velocidade,
    direcao: parada.direcao,
    bateria: parada.bateria,
    bateriaEquipamento: parada.bateriaEquipamento,
    satelite: parada.satelite,
    ignicao: parada.ignicao,
    equipamentoId: parada.equipamentoId,
    equipamentoCodigo: parada.equipamentoCodigo,
    veiculoId: parada.veiculoId,
    placa: parada.placa,
    motoristaNome: parada.motoristaNome,
    entradas: parada.entradas,
    saidas: parada.saidas,
    portaEntrada: parada.portaEntrada,
    portaSaida: parada.portaSaida,
    imagem: parada.imagem,
    id: parada.id,
    i: parada.i,
  }));

  const vistos = new Set<string>();
  const unicos = [...posicoes, ...paradasComoPosicoes].filter((ponto) => {
    const chave = `${ponto.data}|${ponto.latitude}|${ponto.longitude}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });

  unicos.sort(
    (a, b) =>
      parseDataBrParaTimestamp(a.data) - parseDataBrParaTimestamp(b.data),
  );

  let ultimaIgnicao = '';
  return unicos.map((ponto) => {
    const ignicaoAtual = (ponto.ignicao ?? '').trim();
    if (ignicaoAtual) {
      ultimaIgnicao = ignicaoAtual;
      return ponto;
    }
    return { ...ponto, ignicao: ultimaIgnicao };
  });
}

@Injectable()
export class TrajetosService {
  private readonly logger = new Logger(TrajetosService.name);

  constructor(
    private readonly pdfService: TrajetoPdfLogicaService,
    private readonly logicaAuth: LogicaAuthService,
  ) {}

  async obterRelatorio(params: {
    chassi: string;
    dataInicial: string;
    dataFinal: string;
    token?: string;
    baseOrigin?: string;
  }): Promise<Buffer> {
    const { chassi, dataInicial, dataFinal, token, baseOrigin } = params;
    const normalizedChassi = chassi?.trim();

    const veiculo = await this.buscarVeiculoPorChassi(
      chassi,
      baseOrigin,
      token,
    );

    if (!veiculo) {
      throw new NotFoundException(
        'Veículo não encontrado na lista da API Lógica para o chassi informado',
      );
    }

    const trajetos = await this.obterTrajeto(
      veiculo.id,
      dataInicial,
      dataFinal,
      baseOrigin,
      token,
    );

    const posicoes = Array.isArray(trajetos?.relatorio?.posicoes)
      ? trajetos.relatorio.posicoes
      : [];
    const paradas = Array.isArray(trajetos?.relatorio?.paradas)
      ? trajetos.relatorio.paradas
      : [];
    const resumo = (trajetos?.relatorio?.resumo ??
      null) as TrajetoResumo | null;

    return this.pdfService.gerarPdf({
      chassi: normalizedChassi,
      veiculoId: veiculo.id,
      dataInicial,
      dataFinal,
      posicoes: montarLinhaDoTempo(posicoes, paradas),
      resumo,
    });
  }

  /**
   * Busca o veículo na lista da Lógica pelo chassi, com re-autenticação
   * automática quando o token está inválido/expirado.
   *
   * @returns Dados básicos do veículo, ou null quando o chassi não existe
   *          na base da Lógica (lista vazia ou chassi ausente).
   */
  async buscarVeiculoPorChassi(
    chassi: string,
    baseOrigin?: string,
    token?: string,
  ): Promise<LogicaVeiculoInfo | null> {
    const normalizedChassi = chassi?.trim();

    if (!normalizedChassi) {
      throw new NotFoundException(
        'Chassi não informado para consulta na Lógica',
      );
    }

    let usedToken = this.resolverTokenInicial(baseOrigin, token);

    let listaData = await this.consultarListaVeiculo(
      normalizedChassi,
      usedToken,
    );

    if (this.isTokenInvalidResponse(listaData)) {
      this.logger.warn(
        `Token da Lógica inválido/expirado para baseOrigin=${baseOrigin ?? 'N/A'}. Tentando nova autenticação.`,
      );
      usedToken = await this.autenticar(baseOrigin);
      listaData = await this.consultarListaVeiculo(normalizedChassi, usedToken);
    }

    const parsedLista = listaData as LogicaListaResponsePayload;
    const lista = Array.isArray(parsedLista.lista) ? parsedLista.lista : [];

    const veiculoEncontrado = lista.find(
      (item) => String(item.chassi ?? '').trim() === normalizedChassi,
    );

    if (!veiculoEncontrado?.id) {
      return null;
    }

    const veiculoId = Number(veiculoEncontrado.id);
    if (!Number.isFinite(veiculoId)) {
      throw new InternalServerErrorException(
        'ID do veículo retornado pela Lógica é inválido',
      );
    }

    return {
      id: veiculoId,
      placa: String(veiculoEncontrado.placa ?? ''),
      marca: String(veiculoEncontrado.marca ?? ''),
      modelo: String(veiculoEncontrado.modelo ?? ''),
    };
  }

  /**
   * Consulta o /mobile/trajeto da Lógica para o período completo
   * (00:00 da dataInicial até 23:59 da dataFinal), com re-autenticação
   * automática quando o token está inválido/expirado.
   *
   * @param dataInicial - Data no formato ISO YYYY-MM-DD
   * @param dataFinal   - Data no formato ISO YYYY-MM-DD
   */
  async obterTrajeto(
    veiculoId: number,
    dataInicial: string,
    dataFinal: string,
    baseOrigin?: string,
    token?: string,
  ): Promise<TrajetoResponse> {
    let usedToken = this.resolverTokenInicial(baseOrigin, token);

    const dataInicioFormatada = `${this.formatarDataIsoParaBr(dataInicial)} 00:00`;
    const dataFimFormatada = `${this.formatarDataIsoParaBr(dataFinal)} 23:59`;

    let trajetosData = await this.consultarTrajeto(
      veiculoId,
      dataInicioFormatada,
      dataFimFormatada,
      usedToken,
    );

    if (this.isTokenInvalidResponse(trajetosData)) {
      usedToken = await this.autenticar(baseOrigin);
      trajetosData = await this.consultarTrajeto(
        veiculoId,
        dataInicioFormatada,
        dataFimFormatada,
        usedToken,
      );
    }

    return trajetosData as TrajetoResponse;
  }

  /**
   * Busca as posições GPS brutas do período no /mobile/posicao, com
   * re-autenticação automática quando o token está inválido/expirado.
   *
   * É a fonte confiável da trilha completa: o /mobile/trajeto trunca
   * posicoes[] para períodos já consolidados (dias passados voltam com
   * meia dúzia de fixes), enquanto este endpoint devolve todos os fixes.
   *
   * @param dataInicial - Data no formato ISO YYYY-MM-DD
   * @param dataFinal   - Data no formato ISO YYYY-MM-DD
   */
  async obterPosicoes(
    veiculoId: number,
    dataInicial: string,
    dataFinal: string,
    baseOrigin?: string,
    token?: string,
  ): Promise<TrajetoPosicao[]> {
    let usedToken = this.resolverTokenInicial(baseOrigin, token);

    const dataInicioFormatada = `${this.formatarDataIsoParaBr(dataInicial)} 00:00`;
    const dataFimFormatada = `${this.formatarDataIsoParaBr(dataFinal)} 23:59`;

    let posicaoData = await this.consultarPosicao(
      veiculoId,
      dataInicioFormatada,
      dataFimFormatada,
      usedToken,
    );

    if (this.isTokenInvalidResponse(posicaoData)) {
      usedToken = await this.autenticar(baseOrigin);
      posicaoData = await this.consultarPosicao(
        veiculoId,
        dataInicioFormatada,
        dataFimFormatada,
        usedToken,
      );
    }

    const relatorio = (posicaoData as { relatorio?: unknown })?.relatorio;
    return Array.isArray(relatorio) ? (relatorio as TrajetoPosicao[]) : [];
  }

  private resolverTokenInicial(baseOrigin?: string, token?: string): string {
    return this.logicaAuth.obterTokenInicial(baseOrigin, token);
  }

  private async consultarListaVeiculo(
    chassi: string,
    token: string,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.append('chassi', chassi);
    params.append('token', token);

    const response = await axios.post(this.buildUrl('/listaVeiculo'), params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: LOGICA_REQUEST_TIMEOUT,
    });

    return response.data;
  }

  private async consultarTrajeto(
    veiculoId: number,
    dataInicio: string,
    dataFim: string,
    token: string,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.append('veiculoId', String(veiculoId));
    params.append('dataInicio', dataInicio);
    params.append('dataFim', dataFim);
    params.append('token', token);

    const response = await axios.post(LOGICA_TRAJETO_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: LOGICA_REQUEST_TIMEOUT,
    });

    return response.data;
  }

  private async consultarPosicao(
    veiculoId: number,
    dataInicio: string,
    dataFim: string,
    token: string,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.append('veiculoId', String(veiculoId));
    params.append('dataInicio', dataInicio);
    params.append('dataFim', dataFim);
    params.append('token', token);

    // responseType text: o JSON deste endpoint vem malformado e precisa ser
    // corrigido antes do parse (ver parsePosicaoResponse)
    const response = await axios.post(LOGICA_POSICAO_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: LOGICA_POSICAO_TIMEOUT,
      responseType: 'text',
      transformResponse: [(data: unknown) => data],
    });

    return this.parsePosicaoResponse(response.data);
  }

  /**
   * O /mobile/posicao emite JSON inválido: os campos de data vêm SEM aspas
   * ("data":2026-08-11 00:02:04.933). Recebemos o corpo como texto,
   * envolvemos essas datas em aspas e só então fazemos o parse.
   */
  private parsePosicaoResponse(bruto: unknown): unknown {
    if (typeof bruto !== 'string') return bruto;

    const corrigido = bruto.replace(
      /:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/g,
      ':"$1"',
    );

    try {
      return JSON.parse(corrigido);
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Resposta do /mobile/posicao não pôde ser interpretada como JSON: ${mensagem}`,
      );
      return null;
    }
  }

  /** Renova o token via sessão compartilhada (dedupe + retry no LogicaAuthService) */
  private autenticar(baseOrigin?: string): Promise<string> {
    return this.logicaAuth.renovarToken(baseOrigin);
  }

  private buildUrl(path: string): string {
    const baseUrl = process.env.LOGICA_API_BASE_URL;

    if (!baseUrl) {
      throw new InternalServerErrorException(
        'LOGICA_API_BASE_URL não definida nas variáveis de ambiente',
      );
    }

    const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${normalized}/${path.replace(/^\//, '')}`;
  }

  private isTokenInvalidResponse(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;

    const value = data as Record<string, unknown>;
    const logado = value.logado;
    const erro = value.erro;
    const mensagem =
      typeof value.mensagem === 'string' ? value.mensagem.toLowerCase() : '';

    if (logado === false || erro === true) return true;
    if (
      mensagem.includes('token') &&
      (mensagem.includes('inv') || mensagem.includes('expir'))
    ) {
      return true;
    }

    return false;
  }

  private formatarDataIsoParaBr(data: string): string {
    const iso = data?.trim();
    if (!iso) {
      throw new InternalServerErrorException(
        'Data inválida para consulta de trajetos',
      );
    }

    const [ano, mes, dia] = iso.split('-');
    if (!ano || !mes || !dia) {
      throw new InternalServerErrorException(
        'Data deve estar no formato YYYY-MM-DD para consulta de trajetos',
      );
    }

    return `${dia}/${mes}/${ano}`;
  }
}
