import { Injectable, Logger } from '@nestjs/common';
import { baseTag } from './log.util';

export type BaseOrigin = 'MAIS_PRIME' | 'MAIS_PRIME_RS';

type TokenNames = {
  sgaUser: string;
  sgaPassword: string;
  sgaBaseToken: string;
  logica: string;
  softruck: string;
  softruckUsername: string;
  softruckPassword: string;
  softruckPublicKey: string;
  clubgas: string;
  m7Token: string;
  m7Codigo: string;
  apiSecretAlloyal: string;
  alloyalBusinessId: string;
  alloyalBusinessCnpj: string;
};

const TOKEN_MAP: Record<BaseOrigin, TokenNames> = {
  MAIS_PRIME: {
    sgaUser: 'USER_SGA_MAIS_PRIME',
    sgaPassword: 'PASSWORD_SGA_MAIS_PRIME',
    sgaBaseToken: 'TOKEN_BASE_SGA_MAIS_PRIME',
    logica: 'LOGICA_TOKEN',
    softruck: 'SOFTRUCK_TOKEN',
    softruckUsername: 'USERNAME_SOFTRUCK',
    softruckPassword: 'PASSWORD_SOFTRUCK',
    softruckPublicKey: 'PUBLIC_KEY_SOFTRUCK',
    clubgas: 'TOKEN_API_CLUBGAS',
    m7Token: 'MO7_TOKEN',
    m7Codigo: 'M07_CODIGO',
    apiSecretAlloyal: 'API_SECRET_ALLOYAL',
    alloyalBusinessId: 'ALLOYAL_BUSINESS_ID',
    alloyalBusinessCnpj: 'ALLOYAL_BUSINESS_CNPJ',
  },
  MAIS_PRIME_RS: {
    sgaUser: 'USER_SGA_MAIS_PRIME_RS',
    sgaPassword: 'PASSWORD_SGA_MAIS_PRIME_RS',
    sgaBaseToken: 'TOKEN_BASE_SGA_MAIS_PRIME_RS',
    logica: 'LOGICA_TOKEN_RS',
    softruck: 'SOFTRUCK_TOKEN_RS',
    softruckUsername: 'USERNAME_SOFTRUCK_RS',
    softruckPassword: 'PASSWORD_SOFTRUCK_RS',
    softruckPublicKey: 'PUBLIC_KEY_SOFTRUCK_RS',
    clubgas: 'TOKEN_API_CLUBGAS_RS',
    m7Token: 'MO7_TOKEN_RS',
    m7Codigo: 'M07_CODIGO_RS',
    apiSecretAlloyal: 'API_SECRET_ALLOYAL_RS',
    alloyalBusinessId: 'ALLOYAL_BUSINESS_ID_RS',
    alloyalBusinessCnpj: 'ALLOYAL_BUSINESS_CNPJ_RS',
  },
};

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
    // Don't log token values; only indicate which token was resolved
    this.logger.log(`${baseTag(base)} resolved token key ${name}`);
    return val;
  }

  resolveSgaUser(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].sgaUser;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSgaPassword(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].sgaPassword;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSgaBaseToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].sgaBaseToken;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSgaAuthCredentials(baseOrigin: BaseOrigin): SgaAuthCredentials {
    return {
      user: this.resolveSgaUser(baseOrigin),
      password: this.resolveSgaPassword(baseOrigin),
      baseToken: this.resolveSgaBaseToken(baseOrigin),
    };
  }

  resolveLogicaToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].logica;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSoftruckToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].softruck;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSoftruckUsername(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].softruckUsername;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSoftruckPassword(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].softruckPassword;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSoftruckPublicKey(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].softruckPublicKey;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveClubgasToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].clubgas;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveM7Token(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].m7Token;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveM7Codigo(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].m7Codigo;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveApiSecretAlloyal(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].apiSecretAlloyal;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveAlloyalBusinessId(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].alloyalBusinessId;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveAlloyalBusinessCnpj(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].alloyalBusinessCnpj;
    return this.resolveEnv(name, baseOrigin);
  }

  getTokenKey(
    baseOrigin: BaseOrigin,
    kind:
      | 'sgaUser'
      | 'sgaPassword'
      | 'sgaBaseToken'
      | 'logica'
      | 'softruck'
      | 'softruckUsername'
      | 'softruckPassword'
      | 'softruckPublicKey'
      | 'clubgas'
      | 'm7Token'
      | 'm7Codigo'
      | 'apiSecretAlloyal'
      | 'alloyalBusinessId'
      | 'alloyalBusinessCnpj',
  ): string {
    return TOKEN_MAP[baseOrigin][kind];
  }
}
