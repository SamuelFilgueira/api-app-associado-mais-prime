import type { DadosDoPush } from 'src/notifications/domain/push-mensagem';

/**
 * Pushes "avulsos em lote": vários destinatários, cada um com a sua
 * mensagem, sem disparo nem entrega no banco (lembretes e avisos do
 * Associado da Sorte). Vão para a fila de massa em jobs de até 100
 * mensagens — uma chamada ao provedor por job.
 */
export interface PushAvulso {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: DadosDoPush;
}

/**
 * O que o job já fez, gravado no próprio job a cada passo. É o que deixa a
 * nova tentativa continuar de onde parou em vez de reenviar tudo.
 */
export interface ProgressoDosAvulsos {
  /** Posições que já têm resposta do provedor (aceita ou recusada). */
  resolvidos: number[];
  /** Posições aceitas cuja linha da caixa de entrada ainda falta gravar. */
  semHistorico: number[];
}

export interface PushAvulsosJobData {
  mensagens: PushAvulso[];
  _progresso?: ProgressoDosAvulsos;
}

export const PUSH_AVULSOS_POR_JOB = 100;

/** Divide as mensagens em grupos do tamanho de um job. */
export function emLotesDePush<T>(
  mensagens: T[],
  tamanho: number = PUSH_AVULSOS_POR_JOB,
): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < mensagens.length; i += tamanho) {
    lotes.push(mensagens.slice(i, i + tamanho));
  }
  return lotes;
}

export function ehJobDeAvulsos(dados: unknown): dados is PushAvulsosJobData {
  return Array.isArray((dados as { mensagens?: unknown } | null)?.mensagens);
}

/** Posições que ainda não têm resposta do provedor. */
export function posicoesPendentes(
  total: number,
  progresso: ProgressoDosAvulsos | undefined,
): number[] {
  const resolvidos = new Set(progresso?.resolvidos ?? []);
  return Array.from({ length: total }, (_, i) => i).filter(
    (i) => !resolvidos.has(i),
  );
}
