import {
  Inject,
  Injectable,
  Logger,
  Scope,
  UnauthorizedException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import { JwtUser } from 'src/auth/jwt-user.interface';
import {
  TokenResolverService,
  BaseOrigin,
  SgaAuthCredentials,
} from './token-resolver.service';
import { baseTag } from './log.util';

interface RequestWithUser extends Request {
  user?: JwtUser;
}

@Injectable({ scope: Scope.REQUEST })
export class BaseContextService {
  private readonly logger = new Logger(BaseContextService.name);

  constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  getBaseOrigin(): BaseOrigin {
    const baseOrigin = this.request.user?.baseOrigin as BaseOrigin | undefined;

    if (!baseOrigin) {
      const userInfo = this.request.user
        ? JSON.stringify(Object.keys(this.request.user))
        : 'usuário não autenticado';
      this.logger.error(`baseOrigin não encontrado. Disponível: ${userInfo}`);
      throw new UnauthorizedException(
        'Base de origem não configurada no token',
      );
    }

    this.logger.log(`${baseTag(baseOrigin)} Base de origem obtida`);
    return baseOrigin;
  }

  getSgaAuthCredentials(): SgaAuthCredentials {
    const base = this.getBaseOrigin();
    const credentials = this.tokenResolver.resolveSgaAuthCredentials(base);
    this.logger.log(`${baseTag(base)} SGA credentials resolved`);
    return credentials;
  }

  getLogicaToken(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveLogicaToken(base);
    this.logger.log(`${baseTag(base)} LOGICA token resolved`);
    return token;
  }

  getSoftruckToken(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveSoftruckToken(base);
    this.logger.log(`${baseTag(base)} SOFTRUCK token resolved`);
    return token;
  }

  getSoftruckPublicKey(): string {
    const base = this.getBaseOrigin();
    const key = this.tokenResolver.resolveSoftruckPublicKey(base);
    this.logger.log(`${baseTag(base)} SOFTRUCK public key resolved`);
    return key;
  }

  getClubgasToken(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveClubgasToken(base);
    this.logger.log(`${baseTag(base)} CLUBGAS token resolved`);
    return token;
  }

  getM7Token(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveM7Token(base);
    this.logger.log(`${baseTag(base)} M7 token resolved`);
    return token;
  }

  getM7Codigo(): string {
    const base = this.getBaseOrigin();
    const codigo = this.tokenResolver.resolveM7Codigo(base);
    this.logger.log(`${baseTag(base)} M7 Codigo resolved`);
    return codigo;
  }

  getApiSecretAlloyal(): string {
    const base = this.getBaseOrigin();
    const secret = this.tokenResolver.resolveApiSecretAlloyal(base);
    this.logger.log(`${baseTag(base)} API Secret Alloyal resolved`);
    return secret;
  }

  getAlloyalBusinessId(): string {
    const base = this.getBaseOrigin();
    const businessId = this.tokenResolver.resolveAlloyalBusinessId(base);
    this.logger.log(`${baseTag(base)} Alloyal Business ID resolved`);
    return businessId;
  }

  getAlloyalBusinessCnpj(): string {
    const base = this.getBaseOrigin();
    const businessCnpj = this.tokenResolver.resolveAlloyalBusinessCnpj(base);
    this.logger.log(`${baseTag(base)} Alloyal Business CNPJ resolved`);
    return businessCnpj;
  }
}
