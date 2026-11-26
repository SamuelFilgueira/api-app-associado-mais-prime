import {
  BadRequestException,
  Controller,
  Get,
  INestApplication,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from 'src/infra/filters/all-exceptions.filter';
import { clienteHttp } from 'src/infra/auth/testing/jwt-de-teste';
import { requisicaoMiddleware } from 'src/infra/observability/requisicao.middleware';
import {
  DomainError,
  InfraError,
  IntegrationError,
} from 'src/shared/erros/erros';

@Controller('erros')
class ControllerDeErros {
  @Get('http')
  http() {
    throw new BadRequestException('CPF é obrigatório');
  }

  @Get('http-com-code')
  httpComCode() {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'CAMPANHA_TRAVADA',
      message: 'Campanha travada',
    });
  }

  @Get('dominio')
  dominio() {
    throw new DomainError(
      'REVISTORIA_TRANSICAO_INVALIDA',
      'Transição inválida',
      {
        status: 409,
        detalhes: { de: 'APROVADA', para: 'PENDENTE' },
      },
    );
  }

  @Get('timeout')
  timeout() {
    throw new IntegrationError({
      vendor: 'hinova',
      tipo: 'timeout',
      base: 'X',
    });
  }

  @Get('recusado')
  recusado() {
    throw new IntegrationError({
      vendor: 'hinova',
      tipo: 'resposta_invalida',
      detalhes: { corpo: 'segredo interno' },
    });
  }

  @Get('infra')
  infra() {
    throw new InfraError('redis');
  }

  @Get('banco')
  banco() {
    throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
      code: 'P2024',
      clientVersion: 'x',
    });
  }

  @Get('desconhecido')
  desconhecido() {
    throw new TypeError("Cannot read properties of undefined (reading 'cpf')");
  }
}

describe('AllExceptionsFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ControllerDeErros],
    }).compile();
    app = modulo.createNestApplication();
    app.use(requisicaoMiddleware);
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const pedir = (rota: string) =>
    clienteHttp(app)
      .get(`/erros/${rota}`)
      .set('X-Request-Id', 'req-teste-0001');

  it('HttpException: corpo de sempre, com `requestId` aditivo', async () => {
    const resposta = await pedir('http').expect(400);
    expect(resposta.body).toEqual({
      statusCode: 400,
      message: 'CPF é obrigatório',
      error: 'Bad Request',
      requestId: 'req-teste-0001',
    });
    expect(resposta.headers['x-request-id']).toBe('req-teste-0001');
  });

  it('HttpException com `code` do domínio passa como veio', async () => {
    const resposta = await pedir('http-com-code').expect(422);
    expect(resposta.body).toMatchObject({
      statusCode: 422,
      code: 'CAMPANHA_TRAVADA',
      message: 'Campanha travada',
    });
  });

  it('DomainError → status do erro, com `code` e detalhes', async () => {
    const resposta = await pedir('dominio').expect(409);
    expect(resposta.body).toMatchObject({
      statusCode: 409,
      code: 'REVISTORIA_TRANSICAO_INVALIDA',
      message: 'Transição inválida',
      de: 'APROVADA',
      para: 'PENDENTE',
    });
  });

  it('IntegrationError: timeout → 504; resposta inválida → 502, sem detalhe do vendor', async () => {
    const timeout = await pedir('timeout').expect(504);
    expect(timeout.body).toMatchObject({ code: 'INTEGRACAO_TIMEOUT' });

    const recusado = await pedir('recusado').expect(502);
    expect(JSON.stringify(recusado.body)).not.toContain('segredo interno');
    expect(JSON.stringify(recusado.body)).not.toContain('hinova');
  });

  it('InfraError e banco indisponível → 503', async () => {
    const infra = await pedir('infra').expect(503);
    expect(infra.body.code).toBe('INFRA_REDIS_INDISPONIVEL');

    const banco = await pedir('banco').expect(503);
    expect(banco.body.code).toBe('INFRA_BANCO_INDISPONIVEL');
  });

  it('erro desconhecido → 500 genérico com requestId, sem vazar a mensagem', async () => {
    const resposta = await pedir('desconhecido').expect(500);
    expect(resposta.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      requestId: 'req-teste-0001',
    });
  });

  it('gera o requestId quando o proxy não manda', async () => {
    const resposta = await clienteHttp(app).get('/erros/http').expect(400);
    expect(resposta.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resposta.headers['x-request-id']).toBe(resposta.body.requestId);
  });
});
