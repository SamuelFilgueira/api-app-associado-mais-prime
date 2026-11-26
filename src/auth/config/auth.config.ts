/**
 * Fonte única do segredo JWT — antes lido inline (com o mesmo fallback) em
 * auth.module, jwt.strategy, admin-panel.module, analytics.module e
 * analytics.controller.
 *
 * Em produção NÃO existe fallback: sem `JWT_SECRET` o processo falha já no
 * carregamento dos módulos, em vez de subir assinando tokens com um segredo
 * que está no código-fonte. `JWT_SECRET` também é REQUIRED no env.validator.
 *
 * Fora de produção (desenvolvimento e testes) o valor de desenvolvimento
 * continua valendo, para os módulos poderem ser importados sem `.env`.
 */
const SEGREDO_DE_DESENVOLVIMENTO = 'minha_chave_secreta';

export function jwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET não definido: em produção a API não sobe com o segredo de desenvolvimento.',
    );
  }
  return SEGREDO_DE_DESENVOLVIMENTO;
}
