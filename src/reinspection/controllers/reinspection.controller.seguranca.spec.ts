import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/database/prisma.service';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
  tokenDoPainel,
} from 'src/infra/auth/testing/jwt-de-teste';
import { AllExceptionsFilter } from 'src/infra/filters/all-exceptions.filter';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { MailService } from 'src/infra/mail/mail.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { ReinspectionController } from 'src/reinspection/controllers/reinspection.controller';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { ReinspectionAndamentoService } from 'src/reinspection/services/reinspection-andamento.service';
import { ReinspectionAprovacaoService } from 'src/reinspection/services/reinspection-aprovacao.service';
import { ReinspectionAvaliacaoService } from 'src/reinspection/services/reinspection-avaliacao.service';
import { ReinspectionConsultaService } from 'src/reinspection/services/reinspection-consulta.service';
import { ReinspectionEnvioService } from 'src/reinspection/services/reinspection-envio.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { ReinspectionSubmissaoService } from 'src/reinspection/services/reinspection-submissao.service';
import { ReinspectionTemplateService } from 'src/reinspection/services/reinspection-template.service';
import { RevistoriaRegraService } from 'src/reinspection/services/revistoria-regra.service';
import {
  IdempotenciaEmMemoria,
  TravaEmMemoria,
} from 'src/reinspection/testing/montar-reinspection';
import { PrismaRevistoriaMemoria } from 'src/reinspection/testing/prisma-revistoria.memoria';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';

/**
 * Segurança das rotas de revistoria com os guards REAIS (`JwtAuthGuard` e
 * `AdminPanelRoleGuard`, sem override) e os casos de uso reais sobre o
 * Prisma em memória.
 *
 * Regra: nas rotas do app o associado só enxerga e altera revistoria de
 * veículo dele; token com `role` ADMIN (painel e ADMIN legado) é isento.
 */
describe('ReinspectionController (segurança)', () => {
  let app: INestApplication;
  let banco: PrismaRevistoriaMemoria;

  const mail = {
    sendRevistoriaEmail: jest.fn(),
    sendFotoRecusadaReenviadaEmail: jest.fn(),
  };
  const upload = {
    uploadReinspectionPhotoFromBase64: jest.fn(),
    uploadReinspectionTemplatePhoto: jest.fn(),
    deleteReinspectionTemplatePhoto: jest.fn(),
    buildUrl: jest.fn((caminho?: string | null) => caminho ?? null),
  };
  const boleto = { processar: jest.fn(), listarPendentes: jest.fn() };
  const hinova = {
    enviarFotos: jest.fn(),
    reenviar: jest.fn(),
    listarPendentes: jest.fn(),
    listarEnvios: jest.fn(),
  };

  // Dois associados, cada um com um veículo e uma revistoria.
  let dono: { id: number; cpf: string };
  let outro: { id: number; cpf: string };
  let veiculoId: number;
  let revistoriaId: number;
  let fotoReprovadaId: number;

  beforeAll(() => {
    prepararSegredoDeTeste();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mail.sendRevistoriaEmail.mockResolvedValue(undefined);
    mail.sendFotoRecusadaReenviadaEmail.mockResolvedValue(undefined);
    upload.uploadReinspectionPhotoFromBase64.mockResolvedValue(
      'uploads/reinspection-photos/nova.jpg',
    );
    boleto.processar.mockResolvedValue({
      status: 'GERADO',
      nossoNumero: '1',
      tentativas: 1,
      proximaTentativaEm: null,
      erro: null,
    });
    boleto.listarPendentes.mockResolvedValue([]);
    hinova.enviarFotos.mockResolvedValue(null);
    hinova.reenviar.mockResolvedValue({ envioId: 1 });
    hinova.listarPendentes.mockResolvedValue([]);

    banco = new PrismaRevistoriaMemoria();
    const a = banco.comUsuario({ cpf: '11122233344' });
    const b = banco.comUsuario({ cpf: '55566677788' });
    dono = { id: a.id, cpf: '11122233344' };
    outro = { id: b.id, cpf: '55566677788' };
    veiculoId = banco.comVeiculo({ userId: a.id }).id;
    banco.comVeiculo({ userId: b.id });
    revistoriaId = banco.comRevistoria({ userVehicleId: veiculoId }).id;
    banco.comFoto({ reinspectionId: revistoriaId });
    fotoReprovadaId = banco.comFoto({
      reinspectionId: revistoriaId,
      status: 'REPROVADA',
      url: 'uploads/original.jpg',
    }).id;

    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [ReinspectionController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        { provide: PrismaService, useValue: banco },
        ReinspectionRepository,
        ReinspectionPhotoRepository,
        ReinspectionEnvioService,
        ReinspectionSubmissaoService,
        ReinspectionAndamentoService,
        ReinspectionAvaliacaoService,
        ReinspectionAprovacaoService,
        ReinspectionConsultaService,
        ReinspectionTemplateService,
        ReinspectionService,
        RevistoriaRegraService,
        { provide: MailService, useValue: mail },
        { provide: FileUploadService, useValue: upload },
        { provide: TravaService, useValue: new TravaEmMemoria() },
        { provide: IdempotenciaService, useValue: new IdempotenciaEmMemoria() },
        { provide: BoletoReativacaoService, useValue: boleto },
        { provide: ReinspectionHinovaService, useValue: hinova },
      ],
    }).compile();

    app = modulo.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => clienteHttp(app);
  const comoDono = () => bearer(tokenDoApp(dono));
  const comoOutro = () => bearer(tokenDoApp(outro));
  const comoPainel = (adminRole = 'REVISTORIA') =>
    bearer(tokenDoPainel({ id: 1, adminRole }));
  const comoAdminLegado = () => bearer(tokenDoApp({ ...outro, role: 'ADMIN' }));
  const statusDaRevistoria = () =>
    banco.linha('reinspection', revistoriaId).status as string;

  /**
   * Cada rota do app, com o pedido que o DONO faria. `intacto` confere que
   * a tentativa de outro associado não alterou nem disparou nada.
   */
  const rotasDoApp: Array<{
    nome: string;
    pedir: (cabecalho: { Authorization: string } | null) => Promise<{
      status: number;
      body: Record<string, unknown>;
    }>;
    sucesso: number;
    intacto: () => void;
  }> = [
    {
      nome: 'POST /reinspection',
      pedir: (c) =>
        http()
          .post('/reinspection')
          .set(c ?? {})
          .send({ userVehicleId: veiculoId, vehicleType: 'MOTOS' }),
      sucesso: 201,
      intacto: () => expect(banco.tabelas.reinspection).toHaveLength(1),
    },
    {
      nome: 'POST /reinspection/:id/photos',
      pedir: (c) =>
        http()
          .post(`/reinspection/${revistoriaId}/photos`)
          .set(c ?? {})
          .send({ photos: [{ nomeArquivo: 'ordem_1.jpg', binario: 'QUJD' }] }),
      sucesso: 200,
      intacto: () => {
        expect(upload.uploadReinspectionPhotoFromBase64).not.toHaveBeenCalled();
        expect(banco.tabelas.reinspectionPhoto).toHaveLength(2);
      },
    },
    {
      nome: 'POST /reinspection/:id/submit',
      pedir: (c) =>
        http()
          .post(`/reinspection/${revistoriaId}/submit`)
          .set(c ?? {}),
      sucesso: 200,
      intacto: () => expect(mail.sendRevistoriaEmail).not.toHaveBeenCalled(),
    },
    {
      nome: 'GET /reinspection/status',
      pedir: (c) =>
        http()
          .get('/reinspection/status')
          .query({ userVehicleId: veiculoId })
          .set(c ?? {}),
      sucesso: 200,
      intacto: () => undefined,
    },
    {
      nome: 'PATCH /reinspection/status',
      pedir: (c) =>
        http()
          .patch('/reinspection/status')
          .query({ userVehicleId: veiculoId })
          .set(c ?? {}),
      sucesso: 200,
      intacto: () => expect(statusDaRevistoria()).toBe('PENDENTE'),
    },
    {
      nome: 'GET /reinspection/rejected-photos',
      pedir: (c) =>
        http()
          .get('/reinspection/rejected-photos')
          .query({ userVehicleId: veiculoId })
          .set(c ?? {}),
      sucesso: 200,
      intacto: () => undefined,
    },
    {
      nome: 'PATCH /reinspection/finalizar',
      pedir: (c) =>
        http()
          .patch('/reinspection/finalizar')
          .query({ userVehicleId: veiculoId })
          .set(c ?? {}),
      sucesso: 200,
      intacto: () => expect(statusDaRevistoria()).toBe('PENDENTE'),
    },
    {
      nome: 'PATCH /reinspection/photos/:photoId/resend',
      pedir: (c) =>
        http()
          .patch(`/reinspection/photos/${fotoReprovadaId}/resend`)
          .set(c ?? {})
          .send({ base64: 'QUJD' }),
      sucesso: 200,
      intacto: () => {
        expect(upload.uploadReinspectionPhotoFromBase64).not.toHaveBeenCalled();
        expect(banco.linha('reinspectionPhoto', fotoReprovadaId)).toMatchObject(
          { status: 'REPROVADA', url: 'uploads/original.jpg' },
        );
        expect(mail.sendFotoRecusadaReenviadaEmail).not.toHaveBeenCalled();
      },
    },
  ];

  describe.each(rotasDoApp)('$nome', ({ pedir, sucesso, intacto }) => {
    it('sem token → 401', async () => {
      const resposta = await pedir(null);
      expect(resposta.status).toBe(401);
      intacto();
    });

    it('associado que NÃO é dono do veículo → 403, sem ler nem alterar', async () => {
      const resposta = await pedir(comoOutro());

      expect(resposta.status).toBe(403);
      expect(resposta.body.message).toBe(
        'Você não tem permissão para acessar os dados de outra conta',
      );
      // Nada da revistoria alheia vaza no corpo.
      expect(resposta.body).not.toHaveProperty('reinspectionId');
      expect(resposta.body).not.toHaveProperty('status');
      intacto();
    });

    it(`o dono → ${sucesso}`, async () => {
      const resposta = await pedir(comoDono());
      expect(resposta.status).toBe(sucesso);
    });

    it(`painel (ADMIN) é isento da posse → ${sucesso}`, async () => {
      const resposta = await pedir(comoPainel());
      expect(resposta.status).toBe(sucesso);
    });

    it(`ADMIN legado do app é isento da posse → ${sucesso}`, async () => {
      const resposta = await pedir(comoAdminLegado());
      expect(resposta.status).toBe(sucesso);
    });
  });

  describe('o que o dono recebe (contrato do app)', () => {
    it('GET /status devolve a revistoria do veículo dele', async () => {
      const resposta = await http()
        .get('/reinspection/status')
        .query({ userVehicleId: veiculoId })
        .set(comoDono())
        .expect(200);

      expect(resposta.body).toMatchObject({
        userVehicleId: veiculoId,
        hasReinspection: true,
        reinspectionId: revistoriaId,
        status: 'PENDENTE',
      });
    });

    it('PATCH /status devolve EM_ANALISE (o app exige esse valor)', async () => {
      const resposta = await http()
        .patch('/reinspection/status')
        .query({ userVehicleId: veiculoId })
        .set(comoDono())
        .expect(200);

      expect(resposta.body.status).toBe('EM_ANALISE');
    });

    it('PATCH /finalizar devolve FINALIZADA (o app exige esse valor)', async () => {
      const resposta = await http()
        .patch('/reinspection/finalizar')
        .query({ userVehicleId: veiculoId })
        .set(comoDono())
        .expect(200);

      expect(resposta.body.status).toBe('FINALIZADA');
    });

    it('PATCH /status em revistoria APROVADA → 409 com código estável', async () => {
      banco.linha('reinspection', revistoriaId).status = 'APROVADA';

      const resposta = await http()
        .patch('/reinspection/status')
        .query({ userVehicleId: veiculoId })
        .set(comoDono())
        .expect(409);

      expect(resposta.body).toMatchObject({
        statusCode: 409,
        code: 'REVISTORIA_TRANSICAO_INVALIDA',
        statusAtual: 'APROVADA',
        statusPretendido: 'EM_ANALISE',
      });
    });

    it('veículo inexistente continua 404 (antes da posse)', async () => {
      await http()
        .get('/reinspection/status')
        .query({ userVehicleId: 99_999 })
        .set(comoDono())
        .expect(404);
    });
  });

  describe('rotas sem posse por desenho', () => {
    it('GET /template: qualquer usuário autenticado (templates são globais)', async () => {
      banco.comTemplate({ vehicleType: 'MOTOS', ordem: 1 });

      await http().get('/reinspection/template').expect(401);
      const resposta = await http()
        .get('/reinspection/template')
        .set(comoOutro())
        .expect(200);
      expect(resposta.body).toHaveLength(1);
    });

    it('GET /regra: regra da base do token', async () => {
      const resposta = await http()
        .get('/reinspection/regra')
        .set(comoDono())
        .expect(200);
      expect(resposta.body).toMatchObject({
        baseOrigin: 'MAIS_PRIME',
        perfil: 'PADRAO',
      });
    });

    it('GET /regra com token sem base → 422 BASE_NAO_RESOLVIDA (não cai na base padrão)', async () => {
      // Token do painel não carrega base.
      const resposta = await http()
        .get('/reinspection/regra')
        .set(comoPainel())
        .expect(422);
      expect(resposta.body.code).toBe('BASE_NAO_RESOLVIDA');
    });
  });

  describe('rotas do painel seguem exigindo perfil (escopo inalterado)', () => {
    /** Um pedido por rota do painel; cada um só é criado ao ser chamado. */
    const pedidosDoPainel = (cabecalho: { Authorization: string }) => [
      () => http().get('/reinspection').set(cabecalho),
      () => http().get('/reinspection/all').set(cabecalho),
      () =>
        http().get('/reinspection/search').query({ plate: 'A' }).set(cabecalho),
      () => http().get(`/reinspection/${revistoriaId}`).set(cabecalho),
      () => http().get(`/reinspection/${revistoriaId}/photos`).set(cabecalho),
      () => http().get('/reinspection/hinova/pendentes').set(cabecalho),
      () =>
        http()
          .post(`/reinspection/${revistoriaId}/hinova/reenviar`)
          .set(cabecalho),
      () =>
        http()
          .patch(`/reinspection/photos/${fotoReprovadaId}/approve`)
          .set(cabecalho),
      () =>
        http()
          .patch('/reinspection/aprovar')
          .query({ userVehicleId: veiculoId })
          .set(cabecalho),
    ];

    const statusDeCada = async (cabecalho: { Authorization: string }) => {
      const status: number[] = [];
      for (const pedir of pedidosDoPainel(cabecalho)) {
        status.push((await pedir()).status);
      }
      return status;
    };

    it('associado (role USER), mesmo sendo o dono → 403 em todas', async () => {
      const status = await statusDeCada(comoDono());

      expect(status).toEqual(status.map(() => 403));
      expect(boleto.processar).not.toHaveBeenCalled();
      expect(hinova.reenviar).not.toHaveBeenCalled();
      expect(statusDaRevistoria()).toBe('PENDENTE');
    });

    it('perfil MARKETING do painel → 403 em todas', async () => {
      const status = await statusDeCada(comoPainel('MARKETING'));

      expect(status).toEqual(status.map(() => 403));
    });

    it('perfil REVISTORIA do painel → 200 em todas', async () => {
      // Em sequência: a penúltima aprova a foto reprovada e a última, a
      // revistoria.
      const status = await statusDeCada(comoPainel('REVISTORIA'));

      expect(status).toEqual(status.map(() => 200));
      expect(statusDaRevistoria()).toBe('APROVADA');
    });

    it('aprovação registra o usuário do painel na auditoria do envio à Hinova', async () => {
      await http()
        .patch(`/reinspection/photos/${fotoReprovadaId}/approve`)
        .set(comoPainel())
        .expect(200);
      await http()
        .patch('/reinspection/aprovar')
        .query({ userVehicleId: veiculoId })
        .set(bearer(tokenDoPainel({ id: 42, adminRole: 'REVISTORIA' })))
        .set('x-debug-id', 'dbg-9')
        .expect(200);

      expect(hinova.enviarFotos).toHaveBeenCalledWith(revistoriaId, {
        origem: 'APROVACAO',
        adminPanelUserId: 42,
        adminPanelUserEmail: 'painel@teste.local',
        debugId: 'dbg-9',
      });
    });

    it('POST /:id/boleto/gerar: COBRANCA e REVISTORIA entram; MARKETING não', async () => {
      banco.linha('reinspection', revistoriaId).status = 'APROVADA';
      const rota = `/reinspection/${revistoriaId}/boleto/gerar`;

      await http().post(rota).set(comoPainel('MARKETING')).expect(403);
      await http().post(rota).set(comoPainel('COBRANCA')).expect(200);
      await http().post(rota).set(comoPainel('REVISTORIA')).expect(200);

      expect(boleto.processar).toHaveBeenCalledTimes(2);
      expect(boleto.processar).toHaveBeenCalledWith(revistoriaId, {
        origem: 'MANUAL',
        debugId: undefined,
      });
    });

    it('POST /:id/hinova/reenviar repassa o corpo e o usuário do painel', async () => {
      await http()
        .post(`/reinspection/${revistoriaId}/hinova/reenviar`)
        .set(bearer(tokenDoPainel({ id: 42, adminRole: 'REVISTORIA' })))
        .send({ photoIds: [fotoReprovadaId], forcar: true })
        .expect(200);

      expect(hinova.reenviar).toHaveBeenCalledWith(revistoriaId, {
        adminPanelUserId: 42,
        adminPanelUserEmail: 'painel@teste.local',
        photoIds: [fotoReprovadaId],
        forcar: true,
        debugId: undefined,
      });
    });
  });
});
