import {
  Inject,
  Injectable,
  Logger,
  Scope,
  UnauthorizedException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import { JwtUser } from 'src/auth/interfaces/jwt-user.interface';
import {
  TokenResolverService,
  BaseOrigin,
  SgaAuthCredentials,
} from './token-resolver.service';

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

    return baseOrigin;
  }

  getSgaAuthCredentials(): SgaAuthCredentials {
    const base = this.getBaseOrigin();
    const credentials = this.tokenResolver.resolveSgaAuthCredentials(base);
    return credentials;
  }

  getLogicaToken(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveLogicaToken(base);
    return token;
  }

  getSoftruckToken(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveSoftruckToken(base);
    return token;
  }

  getSoftruckUsername(): string {
    const base = this.getBaseOrigin();
    const username = this.tokenResolver.resolveSoftruckUsername(base);
    return username;
  }

  getSoftruckPassword(): string {
    const base = this.getBaseOrigin();
    const password = this.tokenResolver.resolveSoftruckPassword(base);
    return password;
  }

  getSoftruckPublicKey(): string {
    const base = this.getBaseOrigin();
    const key = this.tokenResolver.resolveSoftruckPublicKey(base);
    return key;
  }

  getClubgasToken(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveClubgasToken(base);
    return token;
  }

  getM7Token(): string {
    const base = this.getBaseOrigin();
    const token = this.tokenResolver.resolveM7Token(base);
    return token;
  }

  getM7Codigo(): string {
    const base = this.getBaseOrigin();
    const codigo = this.tokenResolver.resolveM7Codigo(base);
    return codigo;
  }

  getApiSecretAlloyal(): string {
    const base = this.getBaseOrigin();
    const secret = this.tokenResolver.resolveApiSecretAlloyal(base);
    return secret;
  }

  getAlloyalBusinessId(): string {
    const base = this.getBaseOrigin();
    const businessId = this.tokenResolver.resolveAlloyalBusinessId(base);
    return businessId;
  }

  getAlloyalBusinessCnpj(): string {
    const base = this.getBaseOrigin();
    const businessCnpj = this.tokenResolver.resolveAlloyalBusinessCnpj(base);
    return businessCnpj;
  }
}
