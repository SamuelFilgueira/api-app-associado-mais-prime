import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { AlloyalApiService } from 'src/beneficios/services/alloyal-api.service';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';

/**
 * Smoke de contrato: congela o comportamento atual das rotas Alloyal,
 * INCLUSIVE o de headers ausentes responderem 500 (comportamento vigente,
 * catalogado como pendência B4 — só muda com decisão explícita).
 */
describe('AlloyalApiController (contrato)', () => {
  let app: INestApplication;

  const alloyalApiServiceMock = {
    login: jest.fn(),
    getCategories: jest.fn(),
  };

  const sessionHeaders = {
    uid: 'uid-1',
    client: 'client-1',
    'access-token': 'token-1',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AlloyalApiController],
      providers: [
        { provide: AlloyalApiService, useValue: alloyalApiServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
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

  it('POST /alloyal/login devolve uid/client/accessToken da sessão', async () => {
    alloyalApiServiceMock.login.mockResolvedValue({
      uid: 'uid-1',
      client: 'client-1',
      accessToken: 'token-1',
    });

    const response = await request(app.getHttpServer())
      .post('/alloyal/login')
      .send({ cpf: '12345678900', password: 'senha' })
      .expect(201);

    expect(response.body).toEqual({
      uid: 'uid-1',
      client: 'client-1',
      accessToken: 'token-1',
    });
  });

  it('POST /alloyal/login com falha upstream responde 401 com mensagem fixa', async () => {
    alloyalApiServiceMock.login.mockRejectedValue(new Error('upstream caiu'));

    const response = await request(app.getHttpServer())
      .post('/alloyal/login')
      .send({ cpf: '12345678900', password: 'senha' })
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      message: 'Erro ao fazer login na API Alloyal',
    });
  });

  it('GET /alloyal/categories com sessão devolve as categorias do service', async () => {
    const categorias = [{ id: 1, name: 'Alimentação' }];
    alloyalApiServiceMock.getCategories.mockResolvedValue(categorias);

    const response = await request(app.getHttpServer())
      .get('/alloyal/categories')
      .set(sessionHeaders)
      .expect(200);

    expect(response.body).toEqual(categorias);
    expect(alloyalApiServiceMock.getCategories).toHaveBeenCalledWith({
      uid: 'uid-1',
      client: 'client-1',
      accessToken: 'token-1',
    });
  });

  it('GET /alloyal/categories sem headers de sessão responde 500 (comportamento vigente — pendência B4)', async () => {
    const response = await request(app.getHttpServer())
      .get('/alloyal/categories')
      .expect(500);

    expect(response.body).toMatchObject({
      statusCode: 500,
      message: 'Erro ao buscar categorias',
    });
  });
});
