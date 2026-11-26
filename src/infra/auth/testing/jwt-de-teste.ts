import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtStrategy } from 'src/auth/strategies/jwt.strategy';
import { PrismaService } from 'src/database/prisma.service';

/**
 * Apoio aos specs de segurança: monta a autenticação REAL (Passport +
 * `JwtStrategy` + `JwtAuthGuard`), sem `overrideGuard`. Os contract specs
 * sobrescrevem os guards e por isso não pegam rota sem proteção.
 *
 * Uso: chamar `prepararSegredoDeTeste()` antes de compilar o módulo e incluir
 * `...AUTENTICACAO_DE_TESTE.imports` / `.providers` no `createTestingModule`.
 */
export const SEGREDO_DE_TESTE = 'segredo-somente-para-testes';

export function prepararSegredoDeTeste(): void {
  process.env.JWT_SECRET = SEGREDO_DE_TESTE;
}

/**
 * O `JwtStrategy` consulta `user.baseOrigin` para tokens antigos sem a claim
 * de base. O spec que precisar disso declara o próprio `PrismaService` DEPOIS
 * destes providers (o último vence).
 */
const PRISMA_SEM_USUARIOS = {
  user: { findUnique: () => Promise.resolve(null) },
};

export const AUTENTICACAO_DE_TESTE = {
  imports: [PassportModule, JwtModule.register({ secret: SEGREDO_DE_TESTE })],
  providers: [
    { provide: PrismaService, useValue: PRISMA_SEM_USUARIOS },
    JwtStrategy,
  ],
};

const assinador = new JwtService({ secret: SEGREDO_DE_TESTE });

/** Token como o do login do app (`AuthService.login`). */
export function tokenDoApp(usuario: {
  id: number;
  cpf: string;
  role?: 'USER' | 'ADMIN';
  baseOrigin?: string;
}): string {
  return assinador.sign(
    {
      sub: usuario.id,
      cpf: usuario.cpf,
      username: 'Associado de Teste',
      role: usuario.role ?? 'USER',
      baseOrigin: usuario.baseOrigin ?? 'MAIS_PRIME',
    },
    { audience: 'mobile-app' },
  );
}

/** Token como o do login do painel (`AdminPanelUsersService.login`). */
export function tokenDoPainel(usuario: {
  id: number;
  adminRole: string;
}): string {
  return assinador.sign(
    {
      sub: usuario.id,
      email: 'painel@teste.local',
      role: 'ADMIN',
      adminRole: usuario.adminRole,
    },
    { audience: 'admin-panel' },
  );
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** `supertest` sobre o servidor HTTP da aplicação de teste. */
export function clienteHttp(app: INestApplication) {
  return request(app.getHttpServer() as App);
}
