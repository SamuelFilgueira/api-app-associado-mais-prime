/**
 * Configuração de processo, lida uma única vez de `process.env` e tipada.
 *
 * Tudo que é transversal (papel do processo, log, proxy, CORS, métricas,
 * rate limit, limites de corpo) entra aqui — o restante do código não lê
 * `process.env` para essas decisões. Credenciais por base ficam em
 * `tenant.config.ts`/`tenant-credentials.registry.ts`.
 */

import { join } from 'path';

/**
 * Papel do processo. A mesma imagem roda os três:
 *  - `api`: HTTP público; só PRODUZ jobs.
 *  - `worker`: consome as filas e roda os agendadores.
 *  - `pdf`: consome só a fila de renderização de PDF (Chromium).
 *  - `all`: tudo no mesmo processo (desenvolvimento e deploy de processo
 *    único). É o padrão, para que nada mude em quem não definir a env.
 */
export type AppRole = 'api' | 'worker' | 'pdf' | 'all';
export type PapelDeProcesso = Exclude<AppRole, 'all'>;

export type NivelDeLog = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface AppConfig {
  role: AppRole;
  ambiente: string;
  emProducao: boolean;
  port: number;
  log: {
    formato: 'json' | 'text';
    nivel: NivelDeLog;
    /** Mascara CPF, tokens e senhas nas linhas de log. */
    redigirPii: boolean;
  };
  http: {
    /**
     * Valor de `trust proxy` do Express: nº de proxies à frente da API, uma
     * lista de faixas confiáveis ou `false`.
     */
    trustProxy: number | string | false;
    /** Origens aceitas no CORS; `null` mantém o comportamento aberto atual. */
    corsOrigins: string[] | null;
    swaggerHabilitado: boolean;
    limiteCorpoPadrao: string;
    limiteCorpoGrande: string;
    /** Prefixos de rota que aceitam o corpo grande (fotos em base64). */
    rotasCorpoGrande: readonly string[];
  };
  metrics: {
    habilitado: boolean;
    token: string | null;
  };
  rateLimit: {
    habilitado: boolean;
    /** Aplica também as políticas que nascem em modo observação. */
    aplicarTudo: boolean;
  };
  pdf: {
    /** Renderizações simultâneas no processo que tem o Chromium. */
    concorrencia: number;
    /** Quanto a API espera o job de PDF antes de desistir. */
    prazoMs: number;
    /** Chromium do sistema (obrigatório no Docker); vazio usa o do Puppeteer. */
    executavel: string | null;
    /**
     * Diretório de troca entre a API e o processo `pdf`: o HTML vai e o PDF
     * volta por arquivo, para não trafegar megabytes pelo Redis. Em produção
     * é um volume compartilhado pelos dois serviços.
     */
    diretorioDeTroca: string;
  };
}

const ROLES: readonly AppRole[] = ['api', 'worker', 'pdf', 'all'];
const NIVEIS: readonly NivelDeLog[] = [
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/**
 * Rotas cujo corpo JSON carrega arquivo em base64. Só elas mantêm o limite
 * de 20 MB; o restante da API passa a aceitar 1 MB.
 */
const ROTAS_CORPO_GRANDE: readonly string[] = [
  '/api/reinspection',
  '/api/admin/associado-sorte',
];

function booleano(valor: string | undefined, padrao: boolean): boolean {
  if (valor === undefined || valor.trim() === '') return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(valor.trim().toLowerCase());
}

function inteiro(
  valor: string | undefined,
  padrao: number,
  min: number,
  max: number,
): number {
  const n = Number(valor);
  if (valor === undefined || valor.trim() === '' || !Number.isFinite(n)) {
    return padrao;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function lerRole(valor: string | undefined): AppRole {
  const role = (valor ?? '').trim().toLowerCase();
  if (role === '') return 'all';
  if (!ROLES.includes(role as AppRole)) {
    throw new Error(
      `APP_ROLE inválido: "${valor}". Use um de: ${ROLES.join(', ')}.`,
    );
  }
  return role as AppRole;
}

/**
 * Sem a env, confia no `X-Forwarded-For` apenas quando a conexão vem de
 * loopback ou de rede privada — isto é, do Nginx do host ou da rede do
 * Docker. Exposta direto na internet, a API ignora o header (que o cliente
 * controla). `TRUST_PROXY=1` fixa "um proxy à frente"; `false` desliga.
 */
const TRUST_PROXY_PADRAO = 'loopback, linklocal, uniquelocal';

function lerTrustProxy(valor: string | undefined): number | string | false {
  if (valor === undefined || valor.trim() === '') return TRUST_PROXY_PADRAO;
  const texto = valor.trim().toLowerCase();
  if (['false', '0', 'nao', 'no', 'off'].includes(texto)) return false;
  if (['true', 'sim', 'yes', 'on'].includes(texto)) return 1;
  const n = Number(texto);
  if (Number.isInteger(n) && n > 0) return n;
  return valor.trim();
}

function lerOrigens(valor: string | undefined): string[] | null {
  const origens = (valor ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return origens.length > 0 ? origens : null;
}

export function carregarAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const ambiente = (env.NODE_ENV ?? 'development').trim() || 'development';
  const emProducao = ambiente === 'production';
  const nivel = (env.LOG_LEVEL ?? '').trim().toLowerCase() as NivelDeLog;
  const formato = (env.LOG_FORMAT ?? '').trim().toLowerCase();

  return {
    role: lerRole(env.APP_ROLE),
    ambiente,
    emProducao,
    port: inteiro(env.PORT, 3001, 1, 65535),
    log: {
      formato:
        formato === 'json' || formato === 'text'
          ? formato
          : emProducao
            ? 'json'
            : 'text',
      nivel: NIVEIS.includes(nivel) ? nivel : emProducao ? 'log' : 'debug',
      redigirPii: booleano(env.LOG_REDIGIR_PII, true),
    },
    http: {
      trustProxy: lerTrustProxy(env.TRUST_PROXY),
      corsOrigins: lerOrigens(env.CORS_ORIGINS),
      // Em produção o Swagger só sobe se pedido explicitamente.
      swaggerHabilitado: booleano(env.SWAGGER_ENABLED, !emProducao),
      limiteCorpoPadrao: env.BODY_LIMIT_PADRAO?.trim() || '1mb',
      limiteCorpoGrande: env.BODY_LIMIT_GRANDE?.trim() || '20mb',
      rotasCorpoGrande: ROTAS_CORPO_GRANDE,
    },
    metrics: {
      habilitado: booleano(env.METRICS_ENABLED, true),
      token: env.METRICS_TOKEN?.trim() || null,
    },
    rateLimit: {
      habilitado: booleano(env.RATE_LIMIT_ENABLED, true),
      aplicarTudo: booleano(env.RATE_LIMIT_ENFORCE_ALL, false),
    },
    pdf: {
      concorrencia: inteiro(env.PDF_CONCORRENCIA, 2, 1, 8),
      prazoMs: inteiro(env.PDF_PRAZO_MS, 120_000, 5_000, 600_000),
      executavel: env.PUPPETEER_EXECUTABLE_PATH?.trim() || null,
      diretorioDeTroca:
        env.PDF_TMP_DIR?.trim() || join(process.cwd(), 'tmp', 'pdf'),
    },
  };
}

let cache: AppConfig | null = null;

export function appConfig(): AppConfig {
  cache ??= carregarAppConfig();
  return cache;
}

/** Só para testes: descarta a config em cache. */
export function resetAppConfig(): void {
  cache = null;
}

/** O processo atual exerce o papel informado? (`all` exerce todos.) */
export function papelAtivo(
  papel: PapelDeProcesso,
  role: AppRole = appConfig().role,
): boolean {
  return role === 'all' || role === papel;
}
