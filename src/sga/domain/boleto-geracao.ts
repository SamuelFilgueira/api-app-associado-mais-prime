import type { ReinspectionBoletoStatus } from '@prisma/client';
import {
  BoletoReativacaoRetryConfig,
  excedeuJanelaRetry,
  intervaloRetryMs,
} from 'src/sga/config/boleto-reativacao-retry.config';

/**
 * Regras da geração do boleto de reativação que não dependem de I/O: quem
 * pode tentar em cada estado, quando a tentativa está vencida e o que fazer
 * depois de uma falha.
 */

export type BoletoReativacaoOrigem = 'APROVACAO' | 'RETRY' | 'MANUAL';

/**
 * Prazo do lease da geração. Enquanto vale, só o dono cadastra boleto no SGA
 * para a revistoria. Cobre com folga o pior caso de uma tentativa inteira:
 * listagem (30 s) + associado e produtos (45 s cada) + `boleto/cadastrar`
 * (60 s), cada chamada podendo repetir uma vez após troca de token/login.
 */
export const BOLETO_LEASE_MS = 10 * 60_000;

/**
 * Estados da revistoria a partir dos quais cada origem pode tentar gerar.
 *  - a aprovação inicia o processo (qualquer estado, menos `GERADO`);
 *  - a geração manual só atua em quem já passou pelo fluxo;
 *  - o retry só em quem está de fato aguardando retry.
 */
export function estadosQuePermitemGerar(
  origem: BoletoReativacaoOrigem,
): ReinspectionBoletoStatus[] {
  switch (origem) {
    case 'APROVACAO':
      return ['NAO_GERADO', 'PENDENTE_RETRY', 'FALHA'];
    case 'MANUAL':
      return ['PENDENTE_RETRY', 'FALHA'];
    default:
      return ['PENDENTE_RETRY'];
  }
}

/** A tentativa de retry agendada já venceu? Sem data, vale como vencida. */
export function tentativaVencida(
  proximaTentativaEm: Date | null | undefined,
  agora: Date,
): boolean {
  return !proximaTentativaEm || proximaTentativaEm.getTime() <= agora.getTime();
}

/**
 * Início da janela de retry desta tentativa. A janela continua quando o
 * retry (ou a aprovação repetida) encontra a revistoria já em
 * `PENDENTE_RETRY`; tentativa manual, ou vinda de outro estado, reinicia.
 */
export function inicioDaJanelaDeRetry(params: {
  origem: BoletoReativacaoOrigem;
  statusAnterior: ReinspectionBoletoStatus;
  retryInicioEm: Date | null | undefined;
  agora: Date;
}): Date {
  const continua =
    params.origem !== 'MANUAL' &&
    params.statusAnterior === 'PENDENTE_RETRY' &&
    params.retryInicioEm != null;
  return continua ? params.retryInicioEm! : params.agora;
}

export type DecisaoAposFalha =
  | { acao: 'RETENTAR'; proximaTentativaEm: Date }
  | { acao: 'FALHAR'; esgotou: boolean };

/**
 * Depois de uma falha: instabilidade dentro da janela agenda nova tentativa;
 * erro definitivo, ou janela esgotada, encerra em `FALHA`.
 */
export function decidirAposFalha(params: {
  instabilidade: boolean;
  inicioDaJanela: Date;
  agora: Date;
  config: BoletoReativacaoRetryConfig;
}): DecisaoAposFalha {
  const esgotou = excedeuJanelaRetry(
    params.config,
    params.inicioDaJanela.getTime(),
    params.agora.getTime(),
  );
  if (params.instabilidade && !esgotou) {
    return {
      acao: 'RETENTAR',
      proximaTentativaEm: new Date(
        params.agora.getTime() + intervaloRetryMs(params.config),
      ),
    };
  }
  return { acao: 'FALHAR', esgotou };
}

/** Texto gravado em `boletoUltimoErro` e enviado à cobrança quando falha. */
export function motivoDaFalha(
  mensagem: string,
  esgotou: boolean,
  config: BoletoReativacaoRetryConfig,
): string {
  return esgotou
    ? `Janela de retry esgotada (${config.maxHoras}h). Último erro: ${mensagem}`
    : mensagem;
}

const ERRO_MAX_CHARS = 500;

/** `boletoUltimoErro` cabe em 500 caracteres. */
export function truncarErro(valor: string): string {
  return valor.length > ERRO_MAX_CHARS ? valor.slice(0, ERRO_MAX_CHARS) : valor;
}
