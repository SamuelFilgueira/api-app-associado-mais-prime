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

  /**
   * Tokens de base do SGA disponíveis para a base, em ordem de preferência:
   * `TOKEN_BASE_SGA_<BASE>`, `TOKEN_BASE_SGA_<BASE>1`, `TOKEN_BASE_SGA_<BASE>2`…
   * (até 9). Mais de um token permite failover quando a Hinova bloqueia um
   * deles temporariamente por "extração de dados" (ver SgaAuthService).
   * Qualquer combinação vale: só o nome puro, só numerados, ou ambos.
   */
  resolveSgaBaseTokens(baseOrigin: BaseOrigin): string[] {
    const nomeBase = tenantEnvName(baseOrigin, 'sgaBaseToken');
    const nomes = [
      nomeBase,
      ...Array.from({ length: 9 }, (_, i) => `${nomeBase}${i + 1}`),
    ];
    const tokens = nomes
      .map((n) => process.env[n]?.trim())
      .filter((v): v is string => !!v);
    const unicos = [...new Set(tokens)];

    if (unicos.length === 0) {
      this.logger.error(
        `Missing env var ${nomeBase} (ou ${nomeBase}1, ${nomeBase}2…) for base ${baseOrigin}`,
      );
      throw new Error(`Environment variable ${nomeBase} is not configured`);
    }
    return unicos;
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
