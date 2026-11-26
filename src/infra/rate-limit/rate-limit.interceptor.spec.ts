import {
  Body,
  Controller,
  Get,
  INestApplication,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { resetAppConfig } from 'src/config/app.config';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
} from 'src/infra/auth/testing/jwt-de-teste';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { RateLimitInterceptor } from 'src/infra/rate-limit/rate-limit.interceptor';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';

@Controller('teste')
class ControllerDeTeste {
  @LimiteDeTaxa('autenticacao')
  @Post('login')
  login(@Body() body: { cpf: string; password: string }) {
    if (body.password !== 'certa') throw new UnauthorizedException();
    return { ok: true };
  }

  @LimiteDeTaxa('recuperacao_senha')
  @Post('reset')
  reset() {
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('comando')
  @Post('comando')
  comando() {
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('leitura')
  leitura() {
    return { ok: true };
  }

  @LimiteDeTaxa('nenhuma')
  @Get('isenta')
  isenta() {
    return { ok: true };
  }
}

/**
 * Políticas de limite, com o interceptor e o guard reais. O Redis é
 * "derrubado" de propósito: as políticas de abuso continuam valendo pela
 * contagem em memória, e as de uso comum liberam.
 */
describe('RateLimitInterceptor', () => {
  let app: INestApplication;
  let limitador: LimitadorService;
  const redisFora = {
    eval: jest.fn().mockRejectedValue(new Error('Connection is closed.')),
    multi: jest.fn(() => ({
      incr: () => ({
        expire: () => ({ exec: () => Promise.reject(new Error('fora')) }),
      }),
    })),
    decr: jest.fn().mockRejectedValue(new Error('fora')),
    del: jest.fn(),
  };

  beforeAll(async () => {
    prepararSegredoDeTeste();
    resetAppConfig();
    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [ControllerDeTeste],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        LimitadorService,
        { provide: REDIS_CLIENTE, useValue: redisFora },
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
      ],
    }).compile();

    app = modulo.createNestApplication();
    app.useLogger(false);
    await app.init();
    limitador = modulo.get(LimitadorService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    (limitador as unknown as { local: Map<string, unknown> }).local.clear();
  });

  const http = () => clienteHttp(app);
  const login = (cpf: string, password: string) =>
    http().post('/teste/login').send({ cpf, password });

  it('login: cinco senhas erradas bloqueiam a conta por um minuto, com Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      await login('111.222.333-44', 'errada').expect(401);
    }

    const resposta = await login('11122233344', 'errada').expect(429);

    expect(resposta.body).toMatchObject({
      statusCode: 429,
      code: 'LIMITE_DE_REQUISICOES',
    });
    expect(Number(resposta.headers['retry-after'])).toBeGreaterThan(0);
    // Mesmo a senha certa espera a janela: o atacante não descobre que acertou.
    await login('11122233344', 'certa').expect(429);
  });

  it('login certo não consome o limite', async () => {
    for (let i = 0; i < 12; i++) {
      await login('99988877766', 'certa').expect(201);
    }
  });

  it('o bloqueio é por conta: outro CPF segue entrando', async () => {
    for (let i = 0; i < 5; i++)
      await login('11122233344', 'errada').expect(401);
    await login('11122233344', 'errada').expect(429);

    await login('55566677788', 'certa').expect(201);
  });

  it('reset de senha: quarta chamada na hora para o mesmo CPF → 429', async () => {
    const reset = () =>
      http().post('/teste/reset').send({ cpf: '11122233344' });

    await reset().expect(201);
    await reset().expect(201);
    await reset().expect(201);
    await reset().expect(429);
    await http().post('/teste/reset').send({ cpf: '55566677788' }).expect(201);
  });

  it('comando de veículo: por usuário e chassi', async () => {
    const dono = bearer(tokenDoApp({ id: 7, cpf: '11122233344' }));
    const outro = bearer(tokenDoApp({ id: 8, cpf: '55566677788' }));
    const comando = (auth: { Authorization: string }, chassi: string) =>
      http().post('/teste/comando').set(auth).send({ chassi });

    for (let i = 0; i < 6; i++)
      await comando(dono, '9BWZZZ377VT004251').expect(201);
    await comando(dono, '9BWZZZ377VT004251').expect(429);

    await comando(dono, '9BWZZZ377VT009999').expect(201);
    await comando(outro, '9BWZZZ377VT004251').expect(201);
  });

  it('rota autenticada comum, Redis fora: libera (política de leitura)', async () => {
    const auth = bearer(tokenDoApp({ id: 7, cpf: '11122233344' }));
    for (let i = 0; i < 130; i++) {
      await http().get('/teste/leitura').set(auth).expect(200);
    }
  });

  it('rota isenta não consulta o limitador', async () => {
    redisFora.eval.mockClear();
    await http().get('/teste/isenta').expect(200);
    expect(redisFora.eval).not.toHaveBeenCalled();
  });
});
