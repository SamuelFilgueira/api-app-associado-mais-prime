import { createHmac, createHash } from 'crypto';

/** Gera HMAC-SHA256 hex de um valor com o segredo fornecido. */
export function hmacSha256(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/** Gera SHA-256 hex de uma string (para payloadHash). */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Gera o hash canônico de um payload sanitizado para idempotência.
 * Serializa com chaves ordenadas para garantir estabilidade.
 */
export function canonicalPayloadHash(obj: object): string {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return sha256(canonical);
}
