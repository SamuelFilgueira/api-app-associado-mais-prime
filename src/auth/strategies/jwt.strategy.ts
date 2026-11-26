import { jwtSecret } from 'src/auth/config/auth.config';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { BaseOrigin, isTenantBase } from 'src/config/tenant.config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from 'src/database/prisma.service';
import { metricas } from 'src/infra/observability/metricas';

interface PayloadDoToken {
  sub: number | string;
  cpf?: string;
  email?: string;
  username?: string;
  role?: string;
  baseOrigin?: unknown;
  adminRole?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(),
    });
  }

  async validate(payload: PayloadDoToken) {
    return {
      userId: payload.sub,
      // CPF do associado (claim gravada no login do app); ausente em tokens
      // do painel. Usado pelas checagens de posse por documento.
      cpf: payload.cpf,
      email: payload.email,
      username: payload.username,
      role: payload.role,
      baseOrigin: await this.resolverBase(payload),
      adminRole: payload.adminRole,
    };
  }

  /**
   * A base é resolvida aqui, uma única vez, na borda:
   *
   * - claim presente e pertencente a este deploy → usa;
   * - claim presente e desconhecida → 401 (token de outro ambiente ou
   *   adulterado). Antes qualquer valor passava e virava nome de variável de
   *   ambiente mais adiante;
   * - sem claim em token do painel → sem base (o painel informa a base nas
   *   rotas que precisam);
   * - sem claim em token antigo do app → lê `user.baseOrigin`.
   *
   * Se nada disso der uma base, o usuário segue sem ela e as rotas que
   * dependem de base falham fechadas — nunca caem na base padrão.
   */
  private async resolverBase(
    payload: PayloadDoToken,
  ): Promise<BaseOrigin | undefined> {
    const doToken = payload.baseOrigin;

    if (doToken !== undefined && doToken !== null && doToken !== '') {
      if (!isTenantBase(doToken)) {
        metricas.baseAusente.inc({ origem: 'invalida' });
        throw new UnauthorizedException(
          'Token emitido para uma base que não pertence a este ambiente',
        );
      }
      metricas.baseAusente.inc({ origem: 'jwt' });
      return doToken;
    }

    if (payload.adminRole) return undefined;

    const id = Number(payload.sub);
    if (Number.isInteger(id)) {
      const usuario = await this.prisma.user.findUnique({
        where: { id },
        select: { baseOrigin: true },
      });
      if (isTenantBase(usuario?.baseOrigin)) {
        metricas.baseAusente.inc({ origem: 'banco' });
        return usuario.baseOrigin;
      }
    }

    metricas.baseAusente.inc({ origem: 'ausente' });
    return undefined;
  }
}
