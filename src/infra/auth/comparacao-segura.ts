import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compara dois segredos em tempo constante.
 *
 * `===` devolve assim que encontra o primeiro caractere diferente, e o tempo
 * de resposta revela quantos caracteres do token o chamador já acertou. Os
 * dois lados passam por SHA-256 antes do `timingSafeEqual`, que exige buffers
 * do mesmo tamanho — assim nem o comprimento do segredo vaza.
 *
 * Valor ausente, vazio ou que não seja string nunca é igual a nada.
 */
export function segredosIguais(recebido: unknown, esperado: unknown): boolean {
  if (typeof recebido !== 'string' || typeof esperado !== 'string') {
    return false;
  }
  if (recebido.length === 0 || esperado.length === 0) return false;

  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}
