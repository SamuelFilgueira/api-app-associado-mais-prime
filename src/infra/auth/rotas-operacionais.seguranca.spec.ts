import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { AuthController } from 'src/auth/controllers/auth.controller';
import { AuthService } from 'src/auth/services/auth.service';
import { MailService } from 'src/infra/mail/mail.service';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { PopupAuditService } from 'src/notifications/services/popup-audit.service';
import { PushDisparoConsultaService } from 'src/notifications/services/push-disparo-consulta.service';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { TokenResolverService } from 'src/shared/token-resolver.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
  tokenDoPainel,
} from 'src/infra/auth/testing/jwt-de-teste';

/**
 * Rotas operacionais que estavam abertas na internet (fase 0): cadastro
 * direto, renovação do token M7 e push de teste. Guards reais, sem override.
 */
describe('Rotas operacionais (segurança)', () => {
  let app: INestApplication;
  const TOKEN_ADMIN = 'token-admin-de-teste';

  const authService = { register: jest.fn(), resetPassword: jest.fn() };
  const rastreamentoService = { renovarTokenM7: jest.fn() };
  const notificationsService = { sendPushNotification: jest.fn() };
  const fila = { add: jest.fn() };
  const produtor = { enfileirar: jest.fn() };

  beforeAll(async () => {
    prepararSegredoDeTeste();
    process.env.ADMIN_PANEL_TOKEN = TOKEN_ADMIN;

    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [
        AuthController,
        RastreamentoController,
        NotificationsController,
      ],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        { provide: AuthService, useValue: authService },
        { provide: MailService, useValue: {} },
        { provide: RastreamentoService, useValue: rastreamentoService },
        { provide: getQueueToken(WEBHOOK_QUEUE), useValue: fila },
        { provide: ProdutorDeFilas, useValue: produtor },
        { provide: TokenResolverService, useValue: {} },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: MarketingNotificationAuditService, useValue: {} },
        { provide: SituacaoCadastroNotificationService, useValue: {} },
        { provide: MarketingAgendamentoService, useValue: {} },
        { provide: PopupAuditService, useValue: {} },
        { provide: PushDisparoConsultaService, useValue: {} },
      ],
    }).compile();

    app = modulo.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    delete process.env.ADMIN_PANEL_TOKEN;
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fila.add.mockResolvedValue({ id: 'job-1' });
    produtor.enfileirar.mockResolvedValue({ id: 'job-1' });
    authService.register.mockResolvedValue({ id: 1 });
    rastreamentoService.renovarTokenM7.mockResolvedValue({
      MAIS_PRIME: { renovado: true, expires_in: 3600 },
    });
  });

  const http = () => clienteHttp(app);
  const cadastro = {
    name: 'Fulano',
    email: 'fulano@teste.local',
    password: 'Senha@123',
    cpf: '11122233344',
    cep: '30130010',
    address: 'Rua A, 1',
    plate: 'ABC1D23',
  };
  const pushDeTeste = {
    expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    plate: 'ABC1D23',
    ignition: 'on',
    title: 'Teste',
    body: 'Corpo',
  };

  describe('POST /auth/register', () => {
    it('sem x-admin-token → 401 e nenhuma conta é criada', async () => {
      await http().post('/auth/register').send(cadastro).expect(401);
      expect(authService.register).not.toHaveBeenCalled();
    });

    it('Bearer de associado não substitui o x-admin-token → 401', async () => {
      await http()
        .post('/auth/register')
        .set(bearer(tokenDoApp({ id: 1, cpf: '11122233344' })))
        .send(cadastro)
        .expect(401);
    });

    it('token errado → 401; token certo → 201', async () => {
      await http()
        .post('/auth/register')
        .set('x-admin-token', `${TOKEN_ADMIN}x`)
        .send(cadastro)
        .expect(401);
      await http()
        .post('/auth/register')
        .set('x-admin-token', TOKEN_ADMIN)
        .send(cadastro)
        .expect(201);
      expect(authService.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /rastreamento/renovar-token', () => {
    it('sem x-admin-token → 401 e nenhum login é disparado na M7', async () => {
      await http().post('/rastreamento/renovar-token').expect(401);
      expect(rastreamentoService.renovarTokenM7).not.toHaveBeenCalled();
    });

    it('JWT de associado não basta → 401', async () => {
      await http()
        .post('/rastreamento/renovar-token')
        .set(bearer(tokenDoApp({ id: 1, cpf: '11122233344' })))
        .expect(401);
    });

    it('com x-admin-token → 201', async () => {
      const resposta = await http()
        .post('/rastreamento/renovar-token')
        .set('x-admin-token', TOKEN_ADMIN)
        .expect(201);
      expect(resposta.body).toEqual({
        MAIS_PRIME: { renovado: true, expires_in: 3600 },
      });
    });
  });

  describe.each(['/notifications/test', '/notifications/queue-test'])(
    'POST %s',
    (rota) => {
      it('sem token → 401', async () => {
        await http().post(rota).send(pushDeTeste).expect(401);
      });

      it('associado comum → 403', async () => {
        await http()
          .post(rota)
          .set(bearer(tokenDoApp({ id: 1, cpf: '11122233344' })))
          .send(pushDeTeste)
          .expect(403);
        expect(produtor.enfileirar).not.toHaveBeenCalled();
        expect(
          notificationsService.sendPushNotification,
        ).not.toHaveBeenCalled();
      });

      it('token com role ADMIN → 201', async () => {
        await http()
          .post(rota)
          .set(bearer(tokenDoPainel({ id: 1, adminRole: 'ADMIN' })))
          .send(pushDeTeste)
          .expect(201);
      });
    },
  );
});
