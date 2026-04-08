import { Injectable, Logger } from '@nestjs/common';
import { baseTag } from './log.util';

export type BaseOrigin = 'MAIS_PRIME' | 'MAIS_PRIME_RS';

type TokenNames = {
  sga: string;
  logica: string;
  softruck: string;
  softruckPublicKey: string;
};

const TOKEN_MAP: Record<BaseOrigin, TokenNames> = {
  MAIS_PRIME: {
    sga: 'SGA_TOKEN',
    logica: 'LOGICA_TOKEN',
    softruck: 'SOFTRUCK_TOKEN',
    softruckPublicKey: 'PUBLIC_KEY_SOFTRUCK',
  },
  MAIS_PRIME_RS: {
    sga: 'SGA_TOKEN_RS',
    logica: 'LOGICA_TOKEN_RS',
    softruck: 'SOFTRUCK_TOKEN_RS',
    softruckPublicKey: 'PUBLIC_KEY_SOFTRUCK_RS',
  },
};

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

  resolveSgaToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].sga;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveLogicaToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].logica;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSoftruckToken(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].softruck;
    return this.resolveEnv(name, baseOrigin);
  }

  resolveSoftruckPublicKey(baseOrigin: BaseOrigin): string {
    const name = TOKEN_MAP[baseOrigin].softruckPublicKey;
    return this.resolveEnv(name, baseOrigin);
  }

  getTokenKey(baseOrigin: BaseOrigin, kind: 'sga' | 'logica' | 'softruck' | 'softruckPublicKey'): string {
    return TOKEN_MAP[baseOrigin][kind];
  }
}
