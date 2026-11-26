import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Contexto da unidade de trabalho em curso (uma requisição HTTP ou um job),
 * propagado por `AsyncLocalStorage`.
 *
 * Serve só para CARIMBAR log, métrica e trace. Regra de negócio não lê daqui:
 * a base e o usuário chegam aos services por parâmetro.
 */
export interface ContextoExecucao {
  requestId: string;
  base?: string;
  userId?: number | string;
  /** Rota em template (`/api/associado/:id`), nunca a URL com valores. */
  rota?: string;
  queue?: string;
  jobId?: string;
  jobName?: string;
}

const armazenamento = new AsyncLocalStorage<ContextoExecucao>();

const ID_VALIDO = /^[A-Za-z0-9._:-]{8,128}$/;

/** Aceita o id vindo do proxy/cliente só se tiver formato seguro para log. */
export function normalizarRequestId(valor: unknown): string {
  const candidato = Array.isArray(valor) ? (valor[0] as unknown) : valor;
  return typeof candidato === 'string' && ID_VALIDO.test(candidato)
    ? candidato
    : randomUUID();
}

export const contextoExecucao = {
  /** Executa `fn` dentro de um contexto novo. */
  executar<T>(dados: Partial<ContextoExecucao>, fn: () => T): T {
    const contexto: ContextoExecucao = {
      ...dados,
      requestId: dados.requestId ?? randomUUID(),
    };
    return armazenamento.run(contexto, fn);
  },

  atual(): ContextoExecucao | undefined {
    return armazenamento.getStore();
  },

  /** Acrescenta campos ao contexto em curso (ex.: usuário, depois do guard). */
  definir(dados: Partial<ContextoExecucao>): void {
    const contexto = armazenamento.getStore();
    if (!contexto) return;
    for (const [chave, valor] of Object.entries(dados)) {
      if (valor !== undefined && valor !== null) {
        (contexto as unknown as Record<string, unknown>)[chave] = valor;
      }
    }
  },

  requestId(): string | undefined {
    return armazenamento.getStore()?.requestId;
  },
};
