import { Inject, Injectable, Logger, Scope, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import { JwtUser } from 'src/auth/jwt-user.interface';
import { TokenResolverService, BaseOrigin } from './token-resolver.service';
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
            throw new UnauthorizedException('Base de origem não configurada no token');
        }

        this.logger.log(`${baseTag(baseOrigin)} Base de origem obtida`);
        return baseOrigin;
    }

    getSgaToken(): string {
        const base = this.getBaseOrigin();
        const token = this.tokenResolver.resolveSgaToken(base);
        this.logger.log(`${baseTag(base)} SGA token resolved`);
        return token;
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
}