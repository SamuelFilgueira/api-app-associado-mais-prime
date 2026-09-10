/**
 * Constantes da integração M7.
 *
 * A base URL é lida da env em tempo de chamada (mesmo comportamento das
 * interpolações inline que este helper substituiu — inclusive o sufixo
 * "undefined..." quando a env falta; tornar obrigatória é a pendência B7).
 */
export function m7ApiBaseUrl(): string | undefined {
  return process.env.M7_API_BASE_URL;
}
