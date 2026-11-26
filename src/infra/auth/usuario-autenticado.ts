import { ForbiddenException } from '@nestjs/common';

/**
 * Usuário colocado em `request.user` pelo `JwtStrategy.validate`.
 *
 * Dois emissores usam o mesmo segredo:
 * - login do app: `userId` é o id de `user`, sem `adminRole`;
 * - login do painel: `userId` é o id de `AdminPanelUser`, `role` é `ADMIN` e
 *   `adminRole` traz o perfil do painel.
 *
 * Por isso `userId` só identifica um associado quando NÃO há `adminRole`.
 */
export interface UsuarioAutenticado {
  userId: number;
  cpf?: string;
  email?: string;
  username?: string;
  role?: string;
  baseOrigin?: string;
  adminRole?: string;
}

const MSG_OUTRA_CONTA =
  'Você não tem permissão para acessar os dados de outra conta';

/** Só os dígitos de um CPF/CNPJ (aceita valor com máscara). */
export function somenteDigitos(valor: unknown): string {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor).replace(/\D/g, '')
    : '';
}

/** Token com `role` ADMIN: painel administrativo ou ADMIN legado do app. */
export function ehAdmin(user?: UsuarioAutenticado | null): boolean {
  return user?.role === 'ADMIN';
}

/** Token emitido pelo login do painel (carrega o perfil em `adminRole`). */
export function ehTokenDoPainel(user?: UsuarioAutenticado | null): boolean {
  return !!user?.adminRole;
}

/** O token é de um associado e o id dele é o da conta alvo. */
export function ehDonoDaConta(
  user: UsuarioAutenticado | null | undefined,
  alvoUserId: number,
): boolean {
  if (!user || ehTokenDoPainel(user)) return false;
  const id = Number(user.userId);
  return Number.isInteger(id) && id === Number(alvoUserId);
}

/**
 * Libera quando o token é do dono da conta ou tem `role` ADMIN (painel e
 * ADMIN legado, que já operam contas de terceiros hoje). Não muda o escopo de
 * nenhum perfil: só impede que um associado alcance a conta de outro.
 */
export function exigirDonoOuAdmin(
  user: UsuarioAutenticado | null | undefined,
  alvoUserId: number,
): void {
  if (ehAdmin(user) || ehDonoDaConta(user, alvoUserId)) return;
  throw new ForbiddenException(MSG_OUTRA_CONTA);
}

/** Mesma regra de `exigirDonoOuAdmin`, comparando documentos (CPF/CNPJ). */
export function exigirDocumentoProprioOuAdmin(
  user: UsuarioAutenticado | null | undefined,
  documentoDoUsuario: string | null | undefined,
  documentoAlvo: unknown,
): void {
  if (ehAdmin(user)) return;
  const proprio = somenteDigitos(documentoDoUsuario);
  const alvo = somenteDigitos(documentoAlvo);
  if (proprio && alvo && proprio === alvo) return;
  throw new ForbiddenException(MSG_OUTRA_CONTA);
}
