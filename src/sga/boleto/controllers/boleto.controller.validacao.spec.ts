import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
  tokenDoPainel,
} from 'src/infra/auth/testing/jwt-de-teste';
import { BoletoController } from 'src/sga/boleto/controllers/boleto.controller';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';

/** `POST /sga/boleto/listar` com os guards reais: código do veículo só dígitos. */
describe('BoletoController (validação do código do veículo)', () => {
  let app: INestApplication;
  const boletoService = {
    consultarBoletosPorVeiculo: jest.fn().mockResolvedValue([]),
  };
  const associado = bearer(tokenDoApp({ id: 42, cpf: '52998224725' }));

  beforeAll(async () => {
    prepararSegredoDeTeste();
    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [BoletoController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        { provide: BoletoService, useValue: boletoService },
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
  });

  const listar = (corpo: unknown, cabecalho = associado) =>
    clienteHttp(app)
      .post('/sga/boleto/listar')
      .set(cabecalho)
      .send(corpo as object);

  it.each([[987], ['987']])(
    'código numérico (%p): repassa ao service como veio, com o usuário e a base do token',
    async (codigo) => {
      await listar({ codigo_veiculo: codigo }).expect(201);

      expect(boletoService.consultarBoletosPorVeiculo).toHaveBeenCalledWith(
        42,
        codigo,
        'MAIS_PRIME',
      );
    },
  );

  it.each([
    // O app manda `Number(codigo)`: código ausente chega como `null`.
    ['null (NaN serializado pelo app)', { codigo_veiculo: null }],
    ['ausente', {}],
    ['texto', { codigo_veiculo: '987; drop' }],
    ['com caractere de caminho', { codigo_veiculo: '9/../8' }],
    ['negativo', { codigo_veiculo: -1 }],
    ['decimal', { codigo_veiculo: 9.5 }],
    ['objeto', { codigo_veiculo: { $gt: 0 } }],
  ])('código %s → 400, sem consultar', async (_caso, corpo) => {
    await listar(corpo).expect(400);

    expect(boletoService.consultarBoletosPorVeiculo).not.toHaveBeenCalled();
  });

  it('token do painel → 403', async () => {
    await listar(
      { codigo_veiculo: 987 },
      bearer(tokenDoPainel({ id: 42, adminRole: 'COBRANCA' })),
    ).expect(403);
  });
});
