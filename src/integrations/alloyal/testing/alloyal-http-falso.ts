import axios, {
  AxiosAdapter,
  AxiosError,
  AxiosHeaders,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';

/** O que saiu para a Alloyal, como chegaria ao servidor dela. */
export interface RequisicaoAlloyal {
  metodo: string;
  /** URL completa, sem a query string. */
  url: string;
  params?: Record<string, unknown>;
  /** Nomes em minúsculas; sem os cabeçalhos que o próprio axios acrescenta. */
  cabecalhos: Record<string, string>;
  corpo?: unknown;
  timeout?: number;
}

export type RespostaFalsa =
  | { status?: number; data?: unknown; headers?: Record<string, string> }
  | { falha: 'timeout' | 'rede' };

const CABECALHOS_DO_AXIOS = new Set([
  'accept',
  'accept-encoding',
  'content-length',
  'content-type',
  'user-agent',
]);

/**
 * Servidor da Alloyal de mentira, no nível do adaptador do axios: registra
 * cada requisição como ela sairia para a rede e devolve a resposta
 * programada. Não depende de COMO o código chama o axios (instância ou
 * `axios.get`), só do que vai para o fio.
 *
 * `instalar()` tem de vir antes de construir o client.
 */
export class AlloyalHttpFalso {
  readonly requisicoes: RequisicaoAlloyal[] = [];
  private fila: RespostaFalsa[] = [];
  private padrao: RespostaFalsa = { status: 200, data: [] };
  private adaptadorOriginal: typeof axios.defaults.adapter;
  private instalado = false;

  /** Respostas das próximas chamadas, na ordem; depois delas vale a padrão. */
  responder(...respostas: RespostaFalsa[]): this {
    this.fila.push(...respostas);
    return this;
  }

  /** Resposta de toda chamada sem resposta programada (padrão: 200 `[]`). */
  responderSempre(resposta: RespostaFalsa): this {
    this.padrao = resposta;
    return this;
  }

  get ultima(): RequisicaoAlloyal {
    return this.requisicoes[this.requisicoes.length - 1];
  }

  instalar(): void {
    if (this.instalado) return;
    this.adaptadorOriginal = axios.defaults.adapter;
    axios.defaults.adapter = this.adaptador;
    this.instalado = true;
  }

  restaurar(): void {
    if (!this.instalado) return;
    axios.defaults.adapter = this.adaptadorOriginal;
    this.instalado = false;
    this.requisicoes.length = 0;
    this.fila = [];
    this.padrao = { status: 200, data: [] };
  }

  private readonly adaptador: AxiosAdapter = (config) => {
    this.requisicoes.push(registrar(config));
    const resposta = this.fila.shift() ?? this.padrao;

    if ('falha' in resposta) {
      return Promise.reject(
        resposta.falha === 'timeout'
          ? new AxiosError(
              `timeout of ${config.timeout}ms exceeded`,
              AxiosError.ECONNABORTED,
              config,
            )
          : new AxiosError(
              'getaddrinfo ENOTFOUND alloyal',
              'ENOTFOUND',
              config,
            ),
      );
    }

    const completa: AxiosResponse = {
      status: resposta.status ?? 200,
      statusText: '',
      data: resposta.data,
      headers: new AxiosHeaders(resposta.headers ?? {}),
      config,
    };
    const aceita = config.validateStatus;
    if (!aceita || aceita(completa.status)) return Promise.resolve(completa);

    return Promise.reject(
      new AxiosError(
        `Request failed with status code ${completa.status}`,
        completa.status >= 500
          ? AxiosError.ERR_BAD_RESPONSE
          : AxiosError.ERR_BAD_REQUEST,
        config,
        null,
        completa,
      ),
    );
  };
}

function registrar(config: InternalAxiosRequestConfig): RequisicaoAlloyal {
  const caminho = config.url ?? '';
  const url = /^https?:\/\//i.test(caminho)
    ? caminho
    : `${(config.baseURL ?? '').replace(/\/+$/, '')}/${caminho.replace(/^\/+/, '')}`;

  const cabecalhos: Record<string, string> = {};
  const brutos = AxiosHeaders.from(config.headers).toJSON();
  for (const [nome, valor] of Object.entries(brutos)) {
    const chave = nome.toLowerCase();
    if (CABECALHOS_DO_AXIOS.has(chave)) continue;
    if (valor === undefined || valor === null || valor === false) continue;
    cabecalhos[chave] = String(valor as string | number | boolean);
  }

  const requisicao: RequisicaoAlloyal = {
    metodo: String(config.method ?? 'get').toUpperCase(),
    url,
    cabecalhos,
    timeout: config.timeout,
  };
  if (config.params !== undefined) {
    requisicao.params = config.params as Record<string, unknown>;
  }
  if (config.data !== undefined) requisicao.corpo = desserializar(config.data);
  return requisicao;
}

/** O axios entrega o corpo já serializado; desfaz para comparar. */
function desserializar(dado: unknown): unknown {
  if (typeof dado !== 'string') return dado;
  try {
    return JSON.parse(dado) as unknown;
  } catch {
    return dado;
  }
}
