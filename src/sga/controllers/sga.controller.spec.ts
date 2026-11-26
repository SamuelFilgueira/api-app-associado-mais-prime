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
import { SgaController } from 'src/sga/controllers/sga.controller';
import { SgaService } from 'src/sga/services/sga.service';

/**
 * Rotas do app para o SGA com os guards REAIS: formato do chassi (que entra
 * no caminho da chamada ao SGA) e recusa de token do painel.
 */
describe('SgaController (validação de parâmetros e identidade)', () => {
  let app: INestApplication;
  const sgaService = {
    consultarAssociado: jest.fn().mockResolvedValue({ nome: 'Fulano' }),
    consultarVeiculosAssociado: jest.fn().mockResolvedValue([]),
    consultarVeiculoInfo: jest.fn().mockResolvedValue([]),
    setRevistoria: jest.fn().mockResolvedValue(undefined),
  };
  const associado = bearer(
    tokenDoApp({ id: 42, cpf: '52998224725', baseOrigin: 'MAIS_PRIME_RS' }),
  );

  beforeAll(async () => {
    prepararSegredoDeTeste();
    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [SgaController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        { provide: SgaService, useValue: sgaService },
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

  const http = () => clienteHttp(app);

  describe('GET /sga/veiculos-info/:chassi', () => {
    it('chassi alfanumérico: consulta com a base do token', async () => {
      await http()
        .get('/sga/veiculos-info/9BWZZZ377VT004251')
        .set(associado)
        .expect(200);

      expect(sgaService.consultarVeiculoInfo).toHaveBeenCalledWith(
        '9BWZZZ377VT004251',
        'MAIS_PRIME_RS',
      );
    });

    it.each([
      ['curto demais', 'ABC12'],
      ['longo demais', 'A'.repeat(21)],
      ['com hífen', '9BWZZZ-377VT0042'],
      ['com interrogação codificada', '9BWZZZ377%3Fx%3D1'],
      [
        'com barra codificada (outro caminho no SGA)',
        'abc123%2F..%2Fassociado',
      ],
      ['com espaço', '9BW%20ZZZ377VT'],
    ])('chassi %s → 400, sem consultar o SGA', async (_caso, chassi) => {
      await http()
        .get(`/sga/veiculos-info/${chassi}`)
        .set(associado)
        .expect(400);

      expect(sgaService.consultarVeiculoInfo).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /sga/set-revistoria', () => {
    it('chassi válido: 204', async () => {
      await http()
        .patch('/sga/set-revistoria')
        .set(associado)
        .send({ chassi: ' 9BWZZZ377VT004251 ', reinspectionRequired: true })
        .expect(204);

      expect(sgaService.setRevistoria).toHaveBeenCalledWith(
        '9BWZZZ377VT004251',
        true,
      );
    });

    it.each([
      ['com caractere de caminho', '9BW/../x1234'],
      ['curto demais', 'ABC'],
      ['vazio', ''],
      ['que não é texto', 12345678],
    ])('chassi %s → 400', async (_caso, chassi) => {
      await http()
        .patch('/sga/set-revistoria')
        .set(associado)
        .send({ chassi, reinspectionRequired: true })
        .expect(400);

      expect(sgaService.setRevistoria).not.toHaveBeenCalled();
    });

    it('reinspectionRequired que não é booleano → 400 (como antes)', async () => {
      await http()
        .patch('/sga/set-revistoria')
        .set(associado)
        .send({ chassi: '9BWZZZ377VT004251', reinspectionRequired: 'sim' })
        .expect(400);
    });
  });

  describe('identidade', () => {
    it.each([
      ['get', '/sga/associado'],
      ['get', '/sga/veiculos'],
      ['get', '/sga/veiculos-info/9BWZZZ377VT004251'],
    ] as const)('sem token: %s %s → 401', async (metodo, rota) => {
      await http()[metodo](rota).expect(401);
    });

    it('token do painel não age como associado → 403', async () => {
      const painel = bearer(tokenDoPainel({ id: 42, adminRole: 'ADMIN' }));

      await http().get('/sga/associado').set(painel).expect(403);
      await http()
        .patch('/sga/set-revistoria')
        .set(painel)
        .send({ chassi: '9BWZZZ377VT004251', reinspectionRequired: true })
        .expect(403);

      expect(sgaService.consultarAssociado).not.toHaveBeenCalled();
      expect(sgaService.setRevistoria).not.toHaveBeenCalled();
    });

    it('as consultas usam o usuário do token, nunca um id informado', async () => {
      await http().get('/sga/associado?userId=7').set(associado).expect(200);
      await http().get('/sga/veiculos?userId=7').set(associado).expect(200);

      expect(sgaService.consultarAssociado).toHaveBeenCalledWith(42);
      expect(sgaService.consultarVeiculosAssociado).toHaveBeenCalledWith(42);
    });
  });
});
