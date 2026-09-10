import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from 'src/auth/controllers/auth.controller';
import { AuthService } from 'src/auth/services/auth.service';
import { MailService } from 'src/infra/mail/mail.service';

/**
 * Smoke de contrato: congela o shape das respostas do AuthController.
 * O contrato HTTP do app mobile é imutável — qualquer diff aqui é regressão.
 */
describe('AuthController (contrato)', () => {
  let app: INestApplication;

  const authServiceMock = {
    validateUser: jest.fn(),
    login: jest.fn(),
    register: jest.fn(),
    resetPassword: jest.fn(),
    getUserWithPlate: jest.fn(),
  };

  const mailServiceMock = {
    sendPasswordReset: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: MailService, useValue: mailServiceMock },
      ],
    }).compile();

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

  it('POST /auth/login repassa o resultado de AuthService.login sem alterar o shape', async () => {
    const user = { id: 1, cpf: '12345678900', baseOrigin: 'MAIS_PRIME' };
    const loginResult = {
      access_token: 'jwt-token',
      user: { id: 1, name: 'Fulano', primeiroLogin: false },
    };
    authServiceMock.validateUser.mockResolvedValue(user);
    authServiceMock.login.mockResolvedValue(loginResult);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ cpf: '12345678900', password: 'senha123' })
      .expect(201);

    expect(response.body).toEqual(loginResult);
    expect(authServiceMock.validateUser).toHaveBeenCalledWith(
      '12345678900',
      'senha123',
    );
    expect(authServiceMock.login).toHaveBeenCalledWith(user);
  });

  it('POST /auth/login com credenciais inválidas responde 401 com o corpo padrão', async () => {
    authServiceMock.validateUser.mockResolvedValue(null);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ cpf: '12345678900', password: 'errada' })
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      message: 'Credenciais inválidas',
    });
  });
});
