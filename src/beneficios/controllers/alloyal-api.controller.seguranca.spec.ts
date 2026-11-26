import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { AlloyalCashbackService } from 'src/beneficios/services/alloyal-cashback.service';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCuponsService } from 'src/beneficios/services/alloyal-cupons.service';
import { AlloyalSessaoService } from 'src/beneficios/services/alloyal-sessao.service';
import { AlloyalUsuariosService } from 'src/beneficios/services/alloyal-usuarios.service';
import { AlloyalGateway } from 'src/integrations/alloyal/alloyal.gateway';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
  tokenDoPainel,
} from 'src/infra/auth/testing/jwt-de-teste';

/**
 * As rotas de usuário da Alloyal usam a credencial de employee da empresa:
 * cada associado só cria, consulta e altera o próprio usuário.
 */
describe('AlloyalApiController — rotas de usuário (segurança)', () => {
  let app: INestApplication;

  // A regra de posse desceu do controller para o `AlloyalUsuariosService`,
  // que aqui é o REAL; o que se simula é a Alloyal (porta `AlloyalGateway`).
  // Os nomes abaixo são os do service original, apontados para a operação
  // equivalente da porta (mesmos argumentos).
  const service = {
    createUser: jest.fn(),
    updateUser: jest.fn(),
    searchUserByCpf: jest.fn(),
  };
  const alloyal = {
    criarUsuario: service.createUser,
    atualizarUsuario: service.updateUser,
    buscarUsuariosPorCpf: service.searchUserByCpf,
  };
  const DONO = { id: 7, cpf: '11122233344' };
  const OUTRO_CPF = '55566677788';
  const token = () => bearer(tokenDoApp(DONO));

  beforeAll(async () => {
    prepararSegredoDeTeste();
    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [AlloyalApiController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        AlloyalUsuariosService,
        { provide: AlloyalGateway, useValue: alloyal },
        { provide: AlloyalSessaoService, useValue: {} },
        { provide: AlloyalCatalogoService, useValue: {} },
        { provide: AlloyalCashbackService, useValue: {} },
        { provide: AlloyalCuponsService, useValue: {} },
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
    service.createUser.mockResolvedValue({ id: 900, cpf: DONO.cpf });
    service.updateUser.mockResolvedValue({ id: 900, cpf: DONO.cpf });
    service.searchUserByCpf.mockResolvedValue([{ id: 900, cpf: DONO.cpf }]);
  });

  const http = () => clienteHttp(app);

  it('sem token → 401 nas três rotas', async () => {
    await http().get(`/alloyal/users/search/${DONO.cpf}`).expect(401);
    await http().post('/alloyal/users').send({}).expect(401);
    await http().patch(`/alloyal/users/${DONO.cpf}`).send({}).expect(401);
  });

  it('GET users/search/:cpf — CPF de terceiro → 403; o próprio → 200', async () => {
    await http()
      .get(`/alloyal/users/search/${OUTRO_CPF}`)
      .set(token())
      .expect(403);
    expect(service.searchUserByCpf).not.toHaveBeenCalled();

    await http()
      .get(`/alloyal/users/search/${DONO.cpf}`)
      .set(token())
      .expect(200);
    // A base do JWT acompanha a chamada (credencial de employee por base).
    expect(service.searchUserByCpf).toHaveBeenCalledWith(
      'MAIS_PRIME',
      DONO.cpf,
    );
  });

  it('POST users — CPF de terceiro no corpo → 403; o próprio → 201', async () => {
    const corpo = { name: 'Dono', email: 'dono@teste.local', password: 'x' };

    await http()
      .post('/alloyal/users')
      .set(token())
      .send({ ...corpo, cpf: OUTRO_CPF })
      .expect(403);
    expect(service.createUser).not.toHaveBeenCalled();

    await http()
      .post('/alloyal/users')
      .set(token())
      .send({ ...corpo, cpf: DONO.cpf })
      .expect(201);
    expect(service.createUser).toHaveBeenCalledWith(
      'MAIS_PRIME',
      expect.objectContaining({ cpf: DONO.cpf }),
    );
  });

  it('a base repassada é a do token (MAIS_PRIME_RS), não uma base padrão', async () => {
    await http()
      .get(`/alloyal/users/search/${DONO.cpf}`)
      .set(bearer(tokenDoApp({ ...DONO, baseOrigin: 'MAIS_PRIME_RS' })))
      .expect(200);
    expect(service.searchUserByCpf).toHaveBeenCalledWith(
      'MAIS_PRIME_RS',
      DONO.cpf,
    );
  });

  it('token do painel (ADMIN, sem base) → 500 com a mensagem fixa, sem chamar a Alloyal', async () => {
    const painel = bearer(tokenDoPainel({ id: 1, adminRole: 'ADMIN' }));

    const busca = await http()
      .get(`/alloyal/users/search/${DONO.cpf}`)
      .set(painel)
      .expect(500);
    expect(busca.body).toMatchObject({
      statusCode: 500,
      message: 'Erro ao buscar usuário por CPF',
    });

    const edicao = await http()
      .patch(`/alloyal/users/${DONO.cpf}`)
      .set(painel)
      .send({ password: 'nova' })
      .expect(500);
    expect(edicao.body).toMatchObject({
      statusCode: 500,
      message: 'Erro ao atualizar usuário na API Alloyal',
    });

    expect(service.searchUserByCpf).not.toHaveBeenCalled();
    expect(service.updateUser).not.toHaveBeenCalled();
  });

  describe('PATCH users/:id', () => {
    it('id do usuário Alloyal do próprio associado (como o app envia) → 200', async () => {
      await http()
        .patch('/alloyal/users/900')
        .set(token())
        .send({ password: 'nova' })
        .expect(200);
      expect(service.searchUserByCpf).toHaveBeenCalledWith(
        'MAIS_PRIME',
        DONO.cpf,
      );
      expect(service.updateUser).toHaveBeenCalledWith('MAIS_PRIME', '900', {
        password: 'nova',
      });
    });

    it('o próprio CPF no path → 200, sem consulta extra', async () => {
      await http()
        .patch(`/alloyal/users/${DONO.cpf}`)
        .set(token())
        .send({ password: 'nova' })
        .expect(200);
      expect(service.searchUserByCpf).not.toHaveBeenCalled();
    });

    it('id de usuário Alloyal de terceiro → 403', async () => {
      await http()
        .patch('/alloyal/users/901')
        .set(token())
        .send({ password: 'nova' })
        .expect(403);
      expect(service.updateUser).not.toHaveBeenCalled();
    });

    it('busca devolve homônimo de outro CPF com o id pedido → 403', async () => {
      service.searchUserByCpf.mockResolvedValue([{ id: 901, cpf: OUTRO_CPF }]);

      await http()
        .patch('/alloyal/users/901')
        .set(token())
        .send({ password: 'nova' })
        .expect(403);
      expect(service.updateUser).not.toHaveBeenCalled();
    });
  });
});
