import {
  BoletoVerificacaoConfig,
  intervaloConsultaMs,
} from 'src/sga/config/boleto-verificacao.config';

/**
 * Situações do boleto no SGA (tabela oficial da Hinova, igual em todas as
 * empresas) e o que cada uma significa para a verificação de pagamento.
 */

/** 2 = ABERTO. */
export const SITUACAO_BOLETO_ABERTO = '2';
/** 1 BAIXADO, 4 BAIXADO C/ PENDÊNCIA. */
const SITUACOES_PAGO: ReadonlySet<string> = new Set(['1', '4']);
/** 3 CANCELADO, 999 EXCLUÍDO — o boleto nunca mais será pago. */
const SITUACOES_ENCERRADO: ReadonlySet<string> = new Set(['3', '999']);

export type EstadoDoBoleto = 'PAGO' | 'ENCERRADO' | 'EM_ABERTO';

/**
 * O que fazer com o boleto a partir do `codigo_situacao_boleto`. Situação
 * ausente ou desconhecida conta como "em aberto": a verificação segue.
 */
export function estadoDoBoleto(
  codigoSituacao: string | undefined,
): EstadoDoBoleto {
  if (codigoSituacao === undefined) return 'EM_ABERTO';
  if (SITUACOES_PAGO.has(codigoSituacao)) return 'PAGO';
  if (SITUACOES_ENCERRADO.has(codigoSituacao)) return 'ENCERRADO';
  return 'EM_ABERTO';
}

/**
 * Próxima consulta ao SGA na verificação por varredura: quanto mais velho o
 * boleto, mais espaçada (2 min nas primeiras 24 h, depois 10 min, depois
 * 60 min — `boleto-verificacao.config.ts`).
 */
export function proximaConsultaEm(
  config: BoletoVerificacaoConfig,
  params: { criadoEm: number; agora: number },
): Date {
  return new Date(
    params.agora + intervaloConsultaMs(config, params.agora - params.criadoEm),
  );
}
