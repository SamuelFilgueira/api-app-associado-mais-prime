import { Injectable, Optional } from '@nestjs/common';
import {
  BaseOrigin,
  TenantTokenKind,
  tenantEnvName,
} from '../config/tenant.config';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * `BaseOrigin` passou a ser definido em `src/config/tenant.config.ts`.
 * Reexportado aqui para não quebrar os imports existentes.
 */
export type { BaseOrigin } from '../config/tenant.config';

/** Mantido para compatibilidade com o tipo usado por `getTokenKey`. */
export type TokenKind = TenantTokenKind;

export interface SgaAuthCredentials {
  user: string;
  password: string;
  baseToken: string;
}

/**
 * Resolvedor de credenciais por base — API antiga, mantida para os
 * chamadores existentes. Delega ao `TenantCredentialsRegistry`: código novo
 * injeta o registry e pede só a credencial da própria integração.
 *
 * @deprecated use `TenantCredentialsRegistry`.
 */
@Injectable()
export class TokenResolverService {
  constructor(
    // Opcional só para os specs antigos, que instanciam o service com `new`.
    @Optional()
    private readonly registry: TenantCredentialsRegistry = new TenantCredentialsRegistry(),
  ) {}

  private resolve(base: BaseOrigin, kind: TenantTokenKind): string {
    return this.registry.valor(base, kind);
  }

  resolveSgaUser(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'sgaUser');
  }

  resolveSgaPassword(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'sgaPassword');
  }

  /** Tokens de base do SGA da base (ver `TenantCredentialsRegistry`). */
  resolveSgaBaseTokens(baseOrigin: BaseOrigin): string[] {
    return this.registry.tokensBaseSga(baseOrigin);
  }

  /** Primeiro token de base disponível (compatibilidade). */
  resolveSgaBaseToken(baseOrigin: BaseOrigin): string {
    return this.resolveSgaBaseTokens(baseOrigin)[0];
  }

  resolveSgaAuthCredentials(baseOrigin: BaseOrigin): SgaAuthCredentials {
    return {
      user: this.resolveSgaUser(baseOrigin),
      password: this.resolveSgaPassword(baseOrigin),
      baseToken: this.resolveSgaBaseToken(baseOrigin),
    };
  }

  resolveLogicaToken(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'logica');
  }

  resolveSoftruckToken(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'softruck');
  }

  resolveSoftruckUsername(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'softruckUsername');
  }

  resolveSoftruckPassword(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'softruckPassword');
  }

  resolveSoftruckPublicKey(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'softruckPublicKey');
  }

  resolveClubgasToken(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'clubgas');
  }

  resolveM7Token(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'm7Token');
  }

  resolveM7Codigo(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'm7Codigo');
  }

  resolveApiSecretAlloyal(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'apiSecretAlloyal');
  }

  resolveAlloyalBusinessId(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'alloyalBusinessId');
  }

  resolveAlloyalBusinessCnpj(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'alloyalBusinessCnpj');
  }

  /** Nome da variável de ambiente correspondente à base + integração. */
  getTokenKey(baseOrigin: BaseOrigin, kind: TenantTokenKind): string {
    return tenantEnvName(baseOrigin, kind);
  }
}
