import { Injectable } from '@nestjs/common';
import {
  BaseOrigin,
  TenantTokenKind,
  isTenantBase,
} from 'src/config/tenant.config';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/** O que a API da Softruck usa de fato: usuário, senha e chave pública. */
const CREDENCIAIS_USADAS: readonly TenantTokenKind[] = [
  'softruckUsername',
  'softruckPassword',
  'softruckPublicKey',
];

/**
 * Credenciais da Softruck por base, resolvidas pelo próprio provedor.
 *
 * `SOFTRUCK_TOKEN` (tipo `softruck`) não entra: a API autentica por usuário
 * e senha, e a env só é usada por um script de exportação.
 */
@Injectable()
export class SoftruckCredenciais {
  constructor(private readonly registry: TenantCredentialsRegistry) {}

  /** A base tem o que a Softruck exige? Nunca lança nem registra erro. */
  estaConfigurada(base: BaseOrigin): boolean {
    if (!isTenantBase(base)) return false;
    const faltando = this.registry.integracoesIncompletas(base).softruck ?? [];
    return !CREDENCIAIS_USADAS.some((tipo) =>
      faltando.includes(this.registry.nomeDaEnv(base, tipo)),
    );
  }

  /** Chave pública da base; ausente → `IntegrationError` (503). */
  chavePublica(base: BaseOrigin): string {
    return this.registry.valor(base, 'softruckPublicKey');
  }
}
