import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { BaseContextService } from 'src/shared/base-context.service';
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

  const baseContextServiceMock = {
    getBaseOrigin: jest.fn().mockReturnValue('MAIS_PRIME'),
  };

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
        { provide: BaseContextService, useValue: baseContextServiceMock },
        { provide: TokenResolverService, useValue: tokenResolverMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
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
    baseContextServiceMock.getBaseOrigin.mockReturnValue('MAIS_PRIME');
    tokenResolverMock.getTokenKey.mockReturnValue('LOGICA_TOKEN');
    tokenResolverMock.resolveLogicaToken.mockReturnValue('logica-token');
    tokenResolverMock.resolveSoftruckPublicKey.mockReturnValue('softruck-key');
  });

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
      {
        baseOrigin: 'MAIS_PRIME',
        logicaToken: 'logica-token',
        logicaTokenKey: 'LOGICA_TOKEN',
        softruckPublicKey: 'softruck-key',
      },
    );
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

  it('POST /rastreamento/webhook-m7 enfileira o payload e responde queued/jobId', async () => {
    webhookQueueMock.add.mockResolvedValue({ id: 'job-1' });

    const payload = { chassi: 'CHASSI123', evento: 'IGNICAO' };
    const response = await request(app.getHttpServer())
      .post('/rastreamento/webhook-m7')
      .send(payload)
      .expect(201);

    expect(response.body).toEqual({ queued: true, jobId: 'job-1' });
    expect(webhookQueueMock.add).toHaveBeenCalledWith(
      'm7-event',
      { payload },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
  });
});
