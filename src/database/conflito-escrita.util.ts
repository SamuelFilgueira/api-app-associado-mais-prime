/**
 * Conflito de escrita concorrente na mesma linha do banco.
 *
 * - MariaDB ≥ 11.6 (`innodb_snapshot_isolation=ON`, padrão): erro 1020
 *   "Record has changed since last read" quando uma transação tenta gravar
 *   uma linha alterada por outra depois da sua leitura.
 * - MySQL/MariaDB: deadlock 1213; Prisma: `P2034` (write conflict/deadlock).
 *
 * São erros transitórios: repetir a operação inteira resolve.
 */
export function isConflitoEscritaConcorrente(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 'P2034') return true;
  const texto = typeof message === 'string' ? message : '';
  return (
    /Record has changed since last read/i.test(texto) ||
    /\bcode:\s*1020\b/.test(texto) ||
    /\bcode:\s*1213\b/.test(texto) ||
    /Deadlock found/i.test(texto)
  );
}

/**
 * Executa `operacao` repetindo em conflito de escrita concorrente
 * (ver `isConflitoEscritaConcorrente`). A operação precisa ser idempotente.
 */
export async function comRetryEmConflito<T>(
  operacao: () => Promise<T>,
  tentativas = 3,
): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await operacao();
    } catch (error) {
      if (tentativa >= tentativas || !isConflitoEscritaConcorrente(error)) {
        throw error;
      }
      // Pequeno espaçamento aleatório para as requisições concorrentes não
      // colidirem de novo no mesmo instante.
      await new Promise((resolve) =>
        setTimeout(resolve, 20 * tentativa + Math.random() * 30),
      );
    }
  }
}
