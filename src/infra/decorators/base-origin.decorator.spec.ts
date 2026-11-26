import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  BaseOrigin,
  resolverBaseOrigin,
} from 'src/infra/decorators/base-origin.decorator';

/** Usuário que o guard de teste coloca em `request.user` (`null` = nenhum). */
let usuarioDoToken: Record<string, unknown> | null = null;

class GuardDeTeste implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (usuarioDoToken) {
      context.switchToHttp().getRequest().user = usuarioDoToken;
    }
    return true;
  }
}

@Controller('teste-base')
@UseGuards(GuardDeTeste)
class ControllerDeTeste {
  @Get('obrigatoria')
  obrigatoria(@BaseOrigin() baseOrigin: string) {
    return { baseOrigin };
  }

  @Get('opcional')
  opcional(@BaseOrigin({ opcional: true }) baseOrigin?: string) {
    return { baseOrigin: baseOrigin ?? null };
  }
}

function contextoCom(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('@BaseOrigin()', () => {
  describe('resolverBaseOrigin', () => {
    it('com base no token → devolve a base', () => {
      expect(
        resolverBaseOrigin(
          undefined,
          contextoCom({ baseOrigin: 'MAIS_PRIME_RS' }),
        ),
      ).toBe('MAIS_PRIME_RS');
    });

    it.each([
      ['usuário sem base (token do painel)', { adminRole: 'ADMIN' }],
      ['base vazia', { baseOrigin: '' }],
      ['requisição sem usuário', undefined],
    ])('%s → 401 com a mensagem de sempre', (_caso, user) => {
      const chamar = () => resolverBaseOrigin(undefined, contextoCom(user));

      expect(chamar).toThrow(UnauthorizedException);
      expect(chamar).toThrow('Base de origem não configurada no token');
    });

    it('opcional: sem base devolve undefined em vez de lançar', () => {
      expect(
        resolverBaseOrigin(
          { opcional: true },
          contextoCom({ adminRole: 'ADMIN' }),
        ),
      ).toBeUndefined();
      expect(
        resolverBaseOrigin({ opcional: true }, contextoCom(undefined)),
      ).toBeUndefined();
    });

    it('opcional: com base devolve a base', () => {
      expect(
        resolverBaseOrigin(
          { opcional: true },
          contextoCom({ baseOrigin: 'MAIS_PRIME' }),
        ),
      ).toBe('MAIS_PRIME');
    });
  });

  describe('na rota (HTTP)', () => {
    let app: INestApplication;
    const http = () => request(app.getHttpServer() as App);

    beforeAll(async () => {
      const modulo = await Test.createTestingModule({
        controllers: [ControllerDeTeste],
      }).compile();

      app = modulo.createNestApplication();
      // Mesmo pipe global da aplicação: não pode mexer no valor do decorator.
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true }),
      );
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('com base → o handler recebe a base do token', async () => {
      usuarioDoToken = { userId: 1, baseOrigin: 'MAIS_PRIME_RS' };

      const resposta = await http().get('/teste-base/obrigatoria').expect(200);

      expect(resposta.body).toEqual({ baseOrigin: 'MAIS_PRIME_RS' });
    });

    it('sem base → 401 e o handler não roda', async () => {
      usuarioDoToken = { userId: 1, adminRole: 'COBRANCA' };

      const resposta = await http().get('/teste-base/obrigatoria').expect(401);

      expect(resposta.body).toEqual({
        statusCode: 401,
        message: 'Base de origem não configurada no token',
        error: 'Unauthorized',
      });
    });

    it('sem usuário na requisição → 401', async () => {
      usuarioDoToken = null;

      await http().get('/teste-base/obrigatoria').expect(401);
    });

    it('opcional: sem base → 200 com undefined; com base → a base', async () => {
      usuarioDoToken = { userId: 1, adminRole: 'COBRANCA' };
      const semBase = await http().get('/teste-base/opcional').expect(200);
      expect(semBase.body).toEqual({ baseOrigin: null });

      usuarioDoToken = { userId: 1, baseOrigin: 'MAIS_PRIME' };
      const comBase = await http().get('/teste-base/opcional').expect(200);
      expect(comBase.body).toEqual({ baseOrigin: 'MAIS_PRIME' });
    });
  });
});
