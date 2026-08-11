import { Injectable, Logger } from '@nestjs/common';
import {
  BaseOrigin,
  TenantTokenKind,
  tenantEnvName,
} from '../config/tenant.config';

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

@Injectable()
export class TokenResolverService {
  private readonly logger = new Logger(TokenResolverService.name);

  private resolveEnv(name: string, base: BaseOrigin): string {
    const val = process.env[name];
    if (!val) {
      this.logger.error(`Missing env var ${name} for base ${base}`);
      throw new Error(`Environment variable ${name} is not configured`);
    }
    return val;
  }

  private resolve(base: BaseOrigin, kind: TenantTokenKind): string {
    return this.resolveEnv(tenantEnvName(base, kind), base);
  }

  resolveSgaUser(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'sgaUser');
  }

  resolveSgaPassword(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'sgaPassword');
  }

  resolveSgaBaseToken(baseOrigin: BaseOrigin): string {
    return this.resolve(baseOrigin, 'sgaBaseToken');
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
