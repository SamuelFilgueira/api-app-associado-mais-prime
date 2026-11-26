import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { TokenResolverService } from 'src/shared/token-resolver.service';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { M7WebhookGuard } from 'src/rastreamento/guards/m7.guard';

/**
 * Smoke de contrato: congela o shape das rotas principais de rastreamento,
 * incluindo o contexto de tenant repassado ao service.
 * O contrato HTTP do app mobile é imutável — qualquer diff aqui é regressão.
 */
describe('RastreamentoController (contrato)', () => {
  let app: INestApplication;

  const rastreamentoServiceMock = {
    rastreamento: jest.fn(),
    ultimaPosicaoM7: jest.fn(),
    renovarTokenM7: jest.fn(),
  };

  const webhookQueueMock = {
    add: jest.fn(),
  };

  /**
   * Usuário que o `JwtAuthGuard` (sobrescrito) coloca em `request.user`.
   * A base chega ao handler pelo `@BaseOrigin()`; `{}` simula token sem base.
   */
  let usuarioDoToken: { baseOrigin?: string } = { baseOrigin: 'MAIS_PRIME' };

  const tokenResolverMock = {
    getTokenKey: jest.fn().mockReturnValue('LOGICA_TOKEN'),
    resolveLogicaToken: jest.fn().mockReturnValue('logica-token'),
    resolveSoftruckPublicKey: jest.fn().mockReturnValue('softruck-key'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [RastreamentoController],
      providers: [
        { provide: RastreamentoService, useValue: rastreamentoServiceMock },
        { provide: getQueueToken(WEBHOOK_QUEUE), useValue: webhookQueueMock },
        { provide: TokenResolverService, useValue: tokenResolverMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = usuarioDoToken;
          return true;
        },
      })
      .overrideGuard(M7WebhookGuard)
      .useValue({ canActivate: (_context: ExecutionContext) => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    usuarioDoToken = { baseOrigin: 'MAIS_PRIME' };
    tokenResolverMock.getTokenKey.mockReturnValue('LOGICA_TOKEN');
    tokenResolverMock.resolveLogicaToken.mockReturnValue('logica-token');
    tokenResolverMock.resolveSoftruckPublicKey.mockReturnValue('softruck-key');
  });

  // O contexto repassado ao service passou a levar SÓ a base: as credenciais
  // da Lógica e da Softruck saíram do controller (cada provedor resolve a
  // própria). A resposta HTTP é a mesma.
  it('POST /rastreamento monta o contexto de tenant e repassa o resultado do service', async () => {
    const posicao = {
      origem: 'm7',
      latitude: -8.05,
      longitude: -34.9,
      dataUltimaPosicao: '2026-08-31 10:00:00',
    };
    rastreamentoServiceMock.rastreamento.mockResolvedValue(posicao);

    const response = await request(app.getHttpServer())
      .post('/rastreamento')
      .send({ cnpj: '11222333000144', chassi: 'CHASSI123' })
      .expect(201);

    expect(response.body).toEqual(posicao);
    expect(rastreamentoServiceMock.rastreamento).toHaveBeenCalledWith(
      '11222333000144',
      'CHASSI123',
      { baseOrigin: 'MAIS_PRIME' },
    );
    expect(tokenResolverMock.resolveLogicaToken).not.toHaveBeenCalled();
    expect(tokenResolverMock.resolveSoftruckPublicKey).not.toHaveBeenCalled();
  });

  it('POST /rastreamento/ultima-posicao repassa cnpj, chassi e baseOrigin', async () => {
    const posicao = { latitude: -8.05, longitude: -34.9 };
    rastreamentoServiceMock.ultimaPosicaoM7.mockResolvedValue(posicao);

    const response = await request(app.getHttpServer())
      .post('/rastreamento/ultima-posicao')
      .send({ cnpj: '11222333000144', chassi: 'CHASSI123' })
      .expect(201);

    expect(response.body).toEqual(posicao);
    expect(rastreamentoServiceMock.ultimaPosicaoM7).toHaveBeenCalledWith(
      '11222333000144',
      'CHASSI123',
      'MAIS_PRIME',
    );
  });

  it('token sem base responde 401 com a mensagem de sempre e não chama o service', async () => {
    usuarioDoToken = {};

    const response = await request(app.getHttpServer())
      .post('/rastreamento')
      .send({ cnpj: '11222333000144', chassi: 'CHASSI123' })
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      message: 'Base de origem não configurada no token',
    });
    expect(rastreamentoServiceMock.rastreamento).not.toHaveBeenCalled();
    expect(tokenResolverMock.resolveLogicaToken).not.toHaveBeenCalled();
  });

  it('POST /rastreamento/webhook-m7 enfileira o payload e responde queued/jobId', async () => {
    webhookQueueMock.add.mockResolvedValue({ id: 'job-1' });

    const payload = { chassi: 'CHASSI123', evento: 'IGNICAO' };
    const response = await request(app.getHttpServer())
      .post('/rastreamento/webhook-m7')
      .send(payload)
      .expect(201);

    expect(response.body).toEqual({ queued: true, jobId: 'job-1' });
    // O payload do job é o mesmo; as opções passaram a levar só o `jobId`
    // determinístico (retry e retenção vêm do padrão da fila).
    expect(webhookQueueMock.add).toHaveBeenCalledWith(
      'm7-event',
      { payload },
      { jobId: expect.stringMatching(/^m7-[0-9a-f]{64}$/) },
    );
  });

  it('a reentrega do mesmo evento usa o mesmo jobId; evento diferente, outro', async () => {
    webhookQueueMock.add.mockResolvedValue({ id: 'job-1' });
    const evento = {
      chassi: 'CHASSI123',
      evento: 'Ignição Ligada',
      tipoevento: 32,
      codigo: '900001',
      enviado_em: '2026-08-31T13:00:00.000Z',
    };
    const enviar = (payload: object) =>
      request(app.getHttpServer() as App)
        .post('/rastreamento/webhook-m7')
        .send(payload)
        .expect(201);

    await enviar(evento);
    await enviar({ ...evento, scope: 'cliente' });
    await enviar({ ...evento, codigo: '900002' });

    const ids = webhookQueueMock.add.mock.calls.map(
      (chamada) => (chamada[2] as { jobId: string }).jobId,
    );
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
  });
});
