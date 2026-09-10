/**
 * Fonte única do segredo JWT — antes lido inline (com o mesmo fallback) em
 * auth.module, jwt.strategy, admin-panel.module, analytics.module e
 * analytics.controller.
 *
 * O fallback 'minha_chave_secreta' é preservado de propósito (removê-lo é a
 * pendência B7 — exige coordenar deploy nas duas bases). JWT_SECRET é REQUIRED
 * no env.validator, então o fallback é inalcançável em produção.
 */
export function jwtSecret(): string {
  return process.env.JWT_SECRET || 'minha_chave_secreta';
}
