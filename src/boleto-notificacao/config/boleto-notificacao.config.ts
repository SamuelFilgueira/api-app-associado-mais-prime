import { Injectable, Logger } from '@nestjs/common';
import { TENANT } from 'src/config/tenant.config';

export type TipoMensagem = 'D0' | 'D5' | 'D6';
export const TIPOS_MENSAGEM: TipoMensagem[] = ['D0', 'D5', 'D6'];

export interface MensagemConfig {
  titulo: string;
  corpo: string;
}

export interface BoletoNotificacaoConfig {
  /** Rotina agendada ligada (BOLETO_NOTIFICACAO_ENABLED). Execução manual funciona mesmo desligada. */
  enabled: boolean;
  /** Horário do disparo diário (HH:mm, fuso America/Sao_Paulo). */
  horario: string;
  /** Cron derivado do horário. */
  cronPattern: string;
  /** Dias fixos de vencimento monitorados. */
  diasVencimento: number[];
  /** Offsets em dias corridos por tipo de mensagem (D0 é sempre 0). */
  offsets: Record<TipoMensagem, number>;
  /** Dia usado no lugar do dia fixo inexistente em meses curtos (ex.: 28 ⇒ 30 em fevereiro). */
  fallbackMesCurto: number;
  /** Textos por tipo (placeholders: {vencimento}, {quantidade}). */
  mensagens: Record<TipoMensagem, MensagemConfig>;
  /** Registros por página na consulta SGA. */
  quantidadePorPagina: number;
  /** Minutos de espera antes de consultar os receipts do Expo. */
  receiptsDelayMinutos: number;
  /** Tenants processados (default: TENANT.baseNames). */
  tenants: string[];
  /** Base URL da API SGA. */
  sgaBaseUrl: string;
  /** Arquivo JSON usado no lugar do SGA (somente dev/homologação). */
  sgaMockFile?: string;
}

const DEFAULT_MENSAGENS: Record<TipoMensagem, MensagemConfig> = {
  D0: {
    titulo: 'Boleto disponível para pagamento',
    corpo:
      'Seu boleto com vencimento em {vencimento} já está disponível para pagamento.',
  },
  D5: {
    titulo: 'Seu boleto ainda está em aberto',
    corpo:
      'O boleto com vencimento em {vencimento} ainda não foi pago. Regularize para manter sua proteção.',
  },
  D6: {
    titulo: 'Você está desprotegido',
    corpo:
      'O boleto com vencimento em {vencimento} segue em aberto e sua proteção está suspensa. Pague agora para reativar.',
  },
};

export const SGA_BASE_URL_PADRAO = 'https://api.hinova.com.br/api/sga/v2';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(value.trim().toLowerCase());
}

function parseInteiro(
  nome: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${nome}="${value}" inválido: esperado inteiro entre ${min} e ${max}`,
    );
  }
  return parsed;
}

function parseDias(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined || value.trim() === '') return fallback;
  const dias = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v));

  if (
    dias.length === 0 ||
    dias.some((d) => !Number.isInteger(d) || d < 1 || d > 31)
  ) {
    throw new Error(
      `BOLETO_NOTIFICACAO_DIAS_VENCIMENTO="${value}" inválido: use dias 1..31 separados por vírgula`,
    );
  }

  return Array.from(new Set(dias)).sort((a, b) => a - b);
}

function parseHorario(value: string | undefined): {
  horario: string;
  cron: string;
} {
  const raw = (value ?? '09:00').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`BOLETO_NOTIFICACAO_HORARIO="${raw}" inválido: use HH:mm`);
  }
  const hora = Number(match[1]);
  const minuto = Number(match[2]);
  if (hora > 23 || minuto > 59) {
    throw new Error(`BOLETO_NOTIFICACAO_HORARIO="${raw}" inválido: use HH:mm`);
  }
  return {
    horario: `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`,
    cron: `${minuto} ${hora} * * *`,
  };
}

function parseTenants(value: string | undefined): string[] {
  const todos = TENANT.baseNames;
  if (value === undefined || value.trim() === '') return todos;
  const lista = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const desconhecidos = lista.filter((t) => !todos.includes(t));
  if (desconhecidos.length) {
    throw new Error(
      `BOLETO_NOTIFICACAO_TENANTS contém bases desconhecidas: ${desconhecidos.join(', ')} (configuradas: ${todos.join(', ')})`,
    );
  }
  return lista;
}

/**
 * Carrega a configuração da rotina a partir das variáveis de ambiente,
 * aplicando defaults e validando valores. Lança erro em configuração inválida.
 */
export function loadBoletoNotificacaoConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoletoNotificacaoConfig {
  const { horario, cron } = parseHorario(env.BOLETO_NOTIFICACAO_HORARIO);

  const mensagens: Record<TipoMensagem, MensagemConfig> = {
    D0: {
      titulo:
        env.BOLETO_NOTIFICACAO_MSG_D0_TITULO?.trim() ||
        DEFAULT_MENSAGENS.D0.titulo,
      corpo:
        env.BOLETO_NOTIFICACAO_MSG_D0_CORPO?.trim() ||
        DEFAULT_MENSAGENS.D0.corpo,
    },
    D5: {
      titulo:
        env.BOLETO_NOTIFICACAO_MSG_D5_TITULO?.trim() ||
        DEFAULT_MENSAGENS.D5.titulo,
      corpo:
        env.BOLETO_NOTIFICACAO_MSG_D5_CORPO?.trim() ||
        DEFAULT_MENSAGENS.D5.corpo,
    },
    D6: {
      titulo:
        env.BOLETO_NOTIFICACAO_MSG_D6_TITULO?.trim() ||
        DEFAULT_MENSAGENS.D6.titulo,
      corpo:
        env.BOLETO_NOTIFICACAO_MSG_D6_CORPO?.trim() ||
        DEFAULT_MENSAGENS.D6.corpo,
    },
  };

  return {
    enabled: parseBoolean(env.BOLETO_NOTIFICACAO_ENABLED, false),
    horario,
    cronPattern: cron,
    diasVencimento: parseDias(
      env.BOLETO_NOTIFICACAO_DIAS_VENCIMENTO,
      [5, 10, 15, 20, 25, 30],
    ),
    offsets: {
      D0: 0,
      D5: parseInteiro(
        'BOLETO_NOTIFICACAO_OFFSET_D5',
        env.BOLETO_NOTIFICACAO_OFFSET_D5,
        5,
        1,
        60,
      ),
      D6: parseInteiro(
        'BOLETO_NOTIFICACAO_OFFSET_D6',
        env.BOLETO_NOTIFICACAO_OFFSET_D6,
        6,
        1,
        60,
      ),
    },
    fallbackMesCurto: parseInteiro(
      'BOLETO_NOTIFICACAO_FALLBACK_MES_CURTO',
      env.BOLETO_NOTIFICACAO_FALLBACK_MES_CURTO,
      28,
      1,
      28,
    ),
    mensagens,
    quantidadePorPagina: parseInteiro(
      'BOLETO_NOTIFICACAO_QTD_POR_PAGINA',
      env.BOLETO_NOTIFICACAO_QTD_POR_PAGINA,
      500,
      1,
      5000,
    ),
    receiptsDelayMinutos: parseInteiro(
      'BOLETO_NOTIFICACAO_RECEIPTS_DELAY_MIN',
      env.BOLETO_NOTIFICACAO_RECEIPTS_DELAY_MIN,
      15,
      1,
      1440,
    ),
    tenants: parseTenants(env.BOLETO_NOTIFICACAO_TENANTS),
    sgaBaseUrl: (env.SGA_API_BASE_URL?.trim() || SGA_BASE_URL_PADRAO).replace(
      /\/+$/,
      '',
    ),
    sgaMockFile: env.BOLETO_NOTIFICACAO_SGA_MOCK_FILE?.trim() || undefined,
  };
}

/**
 * Provider que expõe a configuração carregada uma única vez no boot.
 */
@Injectable()
export class BoletoNotificacaoConfigService {
  private readonly logger = new Logger(BoletoNotificacaoConfigService.name);
  private readonly config: BoletoNotificacaoConfig;

  constructor() {
    this.config = loadBoletoNotificacaoConfig();
    this.logger.log(
      `[BOLETO-NOTIF] Config: enabled=${this.config.enabled} horario=${this.config.horario} ` +
        `dias=[${this.config.diasVencimento.join(',')}] offsets=D5:${this.config.offsets.D5}/D6:${this.config.offsets.D6} ` +
        `fallbackMesCurto=${this.config.fallbackMesCurto} pagina=${this.config.quantidadePorPagina} ` +
        `tenants=[${this.config.tenants.join(',')}]${this.config.sgaMockFile ? ' MOCK_SGA=' + this.config.sgaMockFile : ''}`,
    );
  }

  get(): BoletoNotificacaoConfig {
    return this.config;
  }
}
