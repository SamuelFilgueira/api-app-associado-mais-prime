import { Injectable, Logger } from '@nestjs/common';
import { TENANT } from 'src/config/tenant.config';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';

/**
 * Etapas da régua de notificações (documento "Régua de notificações push —
 * vencimento do boleto mensal", versão 10/09/2026):
 *  DM5 = D-5 (boleto disponível) · D0 = vence hoje · D1 = D+1 (lembrete leve)
 *  D5 = D+5 (último dia com proteção) · D6 = D+6 (proteção suspensa)
 *  D20 = D+20 (último dia sem nova vistoria)
 */
export type TipoMensagem = 'DM5' | 'D0' | 'D1' | 'D5' | 'D6' | 'D20';
export const TIPOS_MENSAGEM: TipoMensagem[] = [
  'DM5',
  'D0',
  'D1',
  'D5',
  'D6',
  'D20',
];

export interface MensagemConfig {
  titulo: string;
  corpo: string;
}

export interface BoletoNotificacaoConfig {
  /** Rotina agendada ligada (BOLETO_NOTIFICACAO_ENABLED). Execução manual funciona mesmo desligada. */
  enabled: boolean;
  /** Horário do disparo diário (HH:mm, fuso America/Sao_Paulo). Régua: 11:00. */
  horario: string;
  /** Cron derivado do horário. */
  cronPattern: string;
  /**
   * Offsets em dias corridos a partir de D (vencimento efetivo).
   * DM5 é a etapa pré-vencimento: valor N = janela de D-N até D-1.
   */
  offsets: Record<TipoMensagem, number>;
  /** Textos por etapa (tokens: {nome}, {placa}, {mes}, {data}, {vencimento}, {quantidade}). */
  mensagens: Record<TipoMensagem, MensagemConfig>;
  /**
   * Códigos de tipo de boleto considerados na régua (ex.: 1=MENSALIDADE,
   * 5=FECHAMENTO). Vazio = todos os boletos ABERTOS do vencimento.
   */
  codigosTipoBoleto: string[];
  /**
   * Situações de veículo que caracterizam "contrato suspenso" (exigido pela
   * régua nas etapas D+6 e D+20). Vazio = não aplica o filtro extra.
   */
  situacoesContratoSuspenso: string[];
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

/** Textos oficiais da régua (PDF do gestor, versão 10/09/2026). */
const DEFAULT_MENSAGENS: Record<TipoMensagem, MensagemConfig> = {
  DM5: {
    titulo: 'Seu boleto de {mes} já está no app',
    corpo:
      'Oi, {nome}! O boleto da sua proteção já está disponível e vence em {data}. Quando quiser, é só abrir o app e pagar.',
  },
  D0: {
    titulo: 'Seu boleto vence hoje',
    corpo:
      '{nome}, o boleto da proteção do {placa} vence hoje. Pague em poucos toques pelo app e siga tranquilo.',
  },
  D1: {
    titulo: 'Lembrete rápido sobre seu boleto',
    corpo:
      'Oi, {nome}. Notamos que o boleto de {mes} ainda está em aberto. Sem problema — dá pra resolver direto pelo app agora mesmo.',
  },
  D5: {
    titulo: 'Hoje é o último dia para manter sua proteção',
    corpo:
      '{nome}, hoje é o último dia para pagar o boleto de {mes}. A partir de amanhã o {placa} fica sem a proteção da MAIS PRIME. Regularize pelo app.',
  },
  D6: {
    titulo: 'Seu veículo está sem proteção',
    corpo:
      '{nome}, o boleto de {mes} não foi pago e o {placa} está sem a proteção da MAIS PRIME. Regularize agora pelo app e fique protegido de novo.',
  },
  D20: {
    titulo: 'Último dia para reativar sem nova vistoria',
    corpo:
      '{nome}, hoje é o último dia para pagar e reativar sua proteção sem nova vistoria. Depois de hoje, o {placa} precisará ser vistoriado de novo. Resolva pelo app.',
  },
};

/** Offsets padrão da régua (DM5 = janela D-5..D-1). */
const DEFAULT_OFFSETS: Record<TipoMensagem, number> = {
  DM5: 5,
  D0: 0,
  D1: 1,
  D5: 5,
  D6: 6,
  D20: 20,
};

export const SGA_BASE_URL_PADRAO = SGA_BASE_URL;

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

function parseLista(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return Array.from(
    new Set(
      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );
}

function parseHorario(value: string | undefined): {
  horario: string;
  cron: string;
} {
  const raw = (value ?? '11:00').trim();
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

function parseMensagens(
  env: NodeJS.ProcessEnv,
): Record<TipoMensagem, MensagemConfig> {
  const mensagens = {} as Record<TipoMensagem, MensagemConfig>;
  for (const tipo of TIPOS_MENSAGEM) {
    mensagens[tipo] = {
      titulo:
        env[`BOLETO_NOTIFICACAO_MSG_${tipo}_TITULO`]?.trim() ||
        DEFAULT_MENSAGENS[tipo].titulo,
      corpo:
        env[`BOLETO_NOTIFICACAO_MSG_${tipo}_CORPO`]?.trim() ||
        DEFAULT_MENSAGENS[tipo].corpo,
    };
  }
  return mensagens;
}

function parseOffsets(env: NodeJS.ProcessEnv): Record<TipoMensagem, number> {
  const offsets = {} as Record<TipoMensagem, number>;
  for (const tipo of TIPOS_MENSAGEM) {
    // D0 é sempre o próprio vencimento
    offsets[tipo] =
      tipo === 'D0'
        ? 0
        : parseInteiro(
            `BOLETO_NOTIFICACAO_OFFSET_${tipo}`,
            env[`BOLETO_NOTIFICACAO_OFFSET_${tipo}`],
            DEFAULT_OFFSETS[tipo],
            1,
            60,
          );
  }
  return offsets;
}

/**
 * Carrega a configuração da rotina a partir das variáveis de ambiente,
 * aplicando defaults e validando valores. Lança erro em configuração inválida.
 */
export function loadBoletoNotificacaoConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoletoNotificacaoConfig {
  const { horario, cron } = parseHorario(env.BOLETO_NOTIFICACAO_HORARIO);

  return {
    enabled: parseBoolean(env.BOLETO_NOTIFICACAO_ENABLED, false),
    horario,
    cronPattern: cron,
    offsets: parseOffsets(env),
    mensagens: parseMensagens(env),
    codigosTipoBoleto: parseLista(env.BOLETO_NOTIFICACAO_CODIGOS_TIPO_BOLETO),
    situacoesContratoSuspenso: parseLista(
      env.BOLETO_NOTIFICACAO_SITUACOES_SUSPENSO,
    ),
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
        `offsets=DM5:${this.config.offsets.DM5}/D1:${this.config.offsets.D1}/D5:${this.config.offsets.D5}/D6:${this.config.offsets.D6}/D20:${this.config.offsets.D20} ` +
        `tiposBoleto=[${this.config.codigosTipoBoleto.join(',') || 'todos'}] ` +
        `suspenso=[${this.config.situacoesContratoSuspenso.join(',') || 'sem filtro'}] ` +
        `pagina=${this.config.quantidadePorPagina} tenants=[${this.config.tenants.join(',')}]` +
        `${this.config.sgaMockFile ? ' MOCK_SGA=' + this.config.sgaMockFile : ''}`,
    );
  }

  get(): BoletoNotificacaoConfig {
    return this.config;
  }
}
