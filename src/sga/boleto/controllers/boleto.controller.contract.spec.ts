import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { BoletoController } from 'src/sga/boleto/controllers/boleto.controller';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';

/**
 * Smoke de contrato: congela o shape da listagem de boletos.
 * O contrato HTTP do app mobile é imutável — qualquer diff aqui é regressão.
 */
describe('BoletoController (contrato)', () => {
  let app: INestApplication;

  const boletoServiceMock = {
    consultarBoletosPorVeiculo: jest.fn(),
  };

  const jwtUser = {
    userId: 42,
    cpf: '12345678900',
    username: 'fulano',
    role: 'USER',
    baseOrigin: 'MAIS_PRIME',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [BoletoController],
      providers: [{ provide: BoletoService, useValue: boletoServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = jwtUser;
          return true;
        },
      })
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
  });

  it('POST /sga/boleto/listar repassa userId, codigo_veiculo e baseOrigin ao service e devolve o resultado', async () => {
    const boletos = [
      {
        nosso_numero: '123',
        situacao: 'PENDENTE',
        valor: '150.00',
        link_boleto: 'https://exemplo/boleto/123',
      },
    ];
    boletoServiceMock.consultarBoletosPorVeiculo.mockResolvedValue(boletos);

    const response = await request(app.getHttpServer())
      .post('/sga/boleto/listar')
      .send({ codigo_veiculo: 987 })
      .expect(201);

    expect(response.body).toEqual(boletos);
    expect(boletoServiceMock.consultarBoletosPorVeiculo).toHaveBeenCalledWith(
      42,
      987,
      'MAIS_PRIME',
    );
  });
});
