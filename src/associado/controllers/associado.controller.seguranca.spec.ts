import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AssociadoController } from 'src/associado/controllers/associado.controller';
import { AssociadoService } from 'src/associado/services/associado.service';
import { PosseContaService } from 'src/infra/auth/posse-conta.service';
import { PrismaService } from 'src/database/prisma.service';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
  tokenDoPainel,
} from 'src/infra/auth/testing/jwt-de-teste';

/**
 * Segurança das rotas de conta, com o `JwtAuthGuard` real (sem override).
 *
 * Trava os achados da fase 0: perfil e troca de senha de terceiros, consulta
 * anônima por id/CPF e a regra da associação de que o primeiro acesso
 * continua só com o CPF.
 */
describe('AssociadoController (segurança)', () => {
  let app: INestApplication;

  const service = {
    primeiroAcesso: jest.fn(),
    findById: jest.fn(),
    findByCpf: jest.fn(),
    verificarSituacao: jest.fn(),
    findVehiclesByCpf: jest.fn(),
    updateAssociado: jest.fn(),
    changePassword: jest.fn(),
  };
  const prisma = { user: { findUnique: jest.fn() } };

  const DONO = { id: 7, cpf: '11122233344' };
  const OUTRO = { id: 8, cpf: '55566677788' };

  beforeAll(async () => {
    prepararSegredoDeTeste();
    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [AssociadoController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        PosseContaService,
        { provide: AssociadoService, useValue: service },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    app = modulo.createNestApplication();
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
    service.findById.mockResolvedValue({ id: DONO.id, name: 'Dono' });
    service.findByCpf.mockResolvedValue({ id: DONO.id, name: 'Dono' });
    service.changePassword.mockResolvedValue({ primeiroLogin: false });
    service.updateAssociado.mockResolvedValue({ id: DONO.id });
    service.verificarSituacao.mockResolvedValue({ situacao: 'ATIVO' });
    service.findVehiclesByCpf.mockResolvedValue({ vehicles: [] });
    service.primeiroAcesso.mockResolvedValue({ access_token: 't' });
  });

  const http = () => clienteHttp(app);

  describe('GET /associado/:id', () => {
    it('sem token → 401 e o service não é chamado', async () => {
      await http().get(`/associado/${DONO.id}`).expect(401);
      expect(service.findById).not.toHaveBeenCalled();
    });

    it('token de outro associado → 403', async () => {
      await http()
        .get(`/associado/${DONO.id}`)
        .set(bearer(tokenDoApp(OUTRO)))
        .expect(403);
      expect(service.findById).not.toHaveBeenCalled();
    });

    it('o próprio associado → 200', async () => {
      await http()
        .get(`/associado/${DONO.id}`)
        .set(bearer(tokenDoApp(DONO)))
        .expect(200);
      expect(service.findById).toHaveBeenCalledWith(DONO.id);
    });

    it('token do painel → 200 (id do painel não se confunde com o do app)', async () => {
      await http()
        .get(`/associado/${DONO.id}`)
        .set(bearer(tokenDoPainel({ id: 999, adminRole: 'COBRANCA' })))
        .expect(200);
    });
  });

  describe('GET /associado/cpf', () => {
    it('sem token → 401', async () => {
      await http().get('/associado/cpf').query({ cpf: DONO.cpf }).expect(401);
      expect(service.findByCpf).not.toHaveBeenCalled();
    });

    it('CPF de outro associado → 403', async () => {
      await http()
        .get('/associado/cpf')
        .query({ cpf: DONO.cpf })
        .set(bearer(tokenDoApp(OUTRO)))
        .expect(403);
      expect(service.findByCpf).not.toHaveBeenCalled();
    });

    it('o próprio CPF, mesmo com máscara → 200', async () => {
      await http()
        .get('/associado/cpf')
        .query({ cpf: '111.222.333-44' })
        .set(bearer(tokenDoApp(DONO)))
        .expect(200);
    });

    it('painel consulta qualquer CPF (busca do reset de senha) → 200', async () => {
      await http()
        .get('/associado/cpf')
        .query({ cpf: DONO.cpf })
        .set(bearer(tokenDoPainel({ id: 1, adminRole: 'ADMIN' })))
        .expect(200);
    });
  });

  describe('PATCH /associado/:id/password', () => {
    it('associado não troca a senha de outro → 403', async () => {
      await http()
        .patch(`/associado/${DONO.id}/password`)
        .set(bearer(tokenDoApp(OUTRO)))
        .send({ newPassword: 'NovaSenha@1' })
        .expect(403);
      expect(service.changePassword).not.toHaveBeenCalled();
    });

    it('o próprio associado troca a senha → 200', async () => {
      await http()
        .patch(`/associado/${DONO.id}/password`)
        .set(bearer(tokenDoApp(DONO)))
        .send({ newPassword: 'NovaSenha@1' })
        .expect(200);
      expect(service.changePassword).toHaveBeenCalledWith(
        DONO.id,
        'NovaSenha@1',
        expect.objectContaining({ userId: DONO.id }),
      );
    });

    it('painel redefine a senha (reset) → 200, com o perfil na auditoria', async () => {
      await http()
        .patch(`/associado/${DONO.id}/password`)
        .set(bearer(tokenDoPainel({ id: 3, adminRole: 'COBRANCA' })))
        .send({ newPassword: 'NovaSenha@1' })
        .expect(200);
      expect(service.changePassword).toHaveBeenCalledWith(
        DONO.id,
        'NovaSenha@1',
        expect.objectContaining({ adminRole: 'COBRANCA' }),
      );
    });

    it('token do painel com o mesmo id numérico não vira "dono" por coincidência', async () => {
      // O painel passa por ser ADMIN, não por ter sub == id do associado.
      await http()
        .patch(`/associado/${DONO.id}/password`)
        .set(bearer(tokenDoPainel({ id: DONO.id, adminRole: 'MARKETING' })))
        .send({ newPassword: 'NovaSenha@1' })
        .expect(200);
    });
  });

  describe('PATCH /associado/:id', () => {
    it('associado não altera o cadastro de outro → 403', async () => {
      await http()
        .patch(`/associado/${DONO.id}`)
        .set(bearer(tokenDoApp(OUTRO)))
        .send({ email: 'invasor@teste.local' })
        .expect(403);
      expect(service.updateAssociado).not.toHaveBeenCalled();
    });

    it('`cpf` e `profilePhotoUrl` do corpo são descartados', async () => {
      await http()
        .patch(`/associado/${DONO.id}`)
        .set(bearer(tokenDoApp(DONO)))
        .send({
          address: 'Rua Nova, 10',
          cpf: OUTRO.cpf,
          profilePhotoUrl: '../.env',
        })
        .expect(200);
      expect(service.updateAssociado).toHaveBeenCalledWith(
        DONO.id,
        { address: 'Rua Nova, 10' },
        undefined,
      );
    });
  });

  describe('GET /associado/verificar-situacao/:cpf', () => {
    it('sem token → 401 (não dispara consulta à Hinova)', async () => {
      await http().get(`/associado/verificar-situacao/${DONO.cpf}`).expect(401);
      expect(service.verificarSituacao).not.toHaveBeenCalled();
    });

    it('CPF de outro associado → 403', async () => {
      await http()
        .get(`/associado/verificar-situacao/${DONO.cpf}`)
        .set(bearer(tokenDoApp(OUTRO)))
        .expect(403);
    });

    it('o próprio CPF → 200', async () => {
      await http()
        .get(`/associado/verificar-situacao/${DONO.cpf}`)
        .set(bearer(tokenDoApp(DONO)))
        .expect(200);
    });
  });

  it('GET /associado/cpf/:cpf/veiculos de outro CPF → 403', async () => {
    await http()
      .get(`/associado/cpf/${DONO.cpf}/veiculos`)
      .set(bearer(tokenDoApp(OUTRO)))
      .expect(403);
    expect(service.findVehiclesByCpf).not.toHaveBeenCalled();
  });

  it('GET /associado/cpf/:cpf/veiculos com token do painel (sem base) → 200', async () => {
    // A base é opcional nesta rota: só vai para o log.
    await http()
      .get(`/associado/cpf/${DONO.cpf}/veiculos`)
      .set(bearer(tokenDoPainel({ id: 1, adminRole: 'ADMIN' })))
      .expect(200);
    expect(service.findVehiclesByCpf).toHaveBeenCalledWith(DONO.cpf);
  });

  it('POST /associado/primeiro-acesso segue aberto e só com o CPF (regra da associação)', async () => {
    await http()
      .post('/associado/primeiro-acesso')
      .send({ cpf: DONO.cpf })
      .expect(201);
    expect(service.primeiroAcesso).toHaveBeenCalledWith(DONO.cpf);
  });
});
