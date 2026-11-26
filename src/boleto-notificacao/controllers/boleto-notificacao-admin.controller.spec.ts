import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
} from 'src/infra/auth/testing/jwt-de-teste';
import { AllExceptionsFilter } from 'src/infra/filters/all-exceptions.filter';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { BoletoNotificacaoAdminController } from 'src/boleto-notificacao/controllers/boleto-notificacao-admin.controller';
import { BoletoNotificacaoConsultaService } from 'src/boleto-notificacao/services/boleto-notificacao-consulta.service';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoSchedulerService } from 'src/boleto-notificacao/services/boleto-notificacao-scheduler.service';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import {
  boletoSga,
  consultaSga,
  montarRegua,
} from 'src/boleto-notificacao/testing/montar-regua';

jest.mock('src/config/tenant.config', () => ({
  TENANT: {
    baseNames: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    defaultBase: 'MAIS_PRIME',
  },
  isTenantBase: (v: unknown) => v === 'MAIS_PRIME' || v === 'MAIS_PRIME_RS',
}));

/**
 * `POST /boleto-notificacao/admin/executar` com os guards reais e a régua
 * inteira por trás (só SGA, fila, trava e Expo são dublês).
 */
describe('BoletoNotificacaoAdminController — POST executar', () => {
  let app: INestApplication;
  let regua: ReturnType<typeof montarRegua>;
  const produtor = { enfileirar: jest.fn() };
  const admin = bearer(
    tokenDoApp({ id: 1, cpf: '11122233344', role: 'ADMIN' }),
  );
  const CHAVE = 'boleto-regua:MAIS_PRIME:2026-09-10';

  beforeAll(async () => {
    prepararSegredoDeTeste();
    regua = montarRegua();

    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [BoletoNotificacaoAdminController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        { provide: BoletoNotificacaoService, useValue: regua.service },
        { provide: BoletoNotificacaoReceiptsService, useValue: regua.receipts },
        { provide: BoletoNotificacaoConfigService, useValue: regua.config },
        { provide: BoletoNotificacaoConsultaService, useValue: {} },
        { provide: BoletoNotificacaoSchedulerService, useValue: {} },
        { provide: ProdutorDeFilas, useValue: produtor },
      ],
    }).compile();

    app = modulo.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    produtor.enfileirar.mockReset().mockResolvedValue({ id: 'job-7' });
    regua.sgaClient.listarAbertosPorVencimento
      .mockReset()
      .mockResolvedValue(consultaSga([boletoSga()]));
    regua.trava.ocupadas.clear();
  });

  const executar = (corpo: Record<string, unknown>, headers = admin) =>
    clienteHttp(app)
      .post('/boleto-notificacao/admin/executar')
      .set(headers)
      .send(corpo);

  it('só ADMIN: sem token → 401; associado comum → 403', async () => {
    await clienteHttp(app)
      .post('/boleto-notificacao/admin/executar')
      .send({ sync: true })
      .expect(401);
    await executar(
      { sync: true },
      bearer(tokenDoApp({ id: 2, cpf: '22233344455' })),
    ).expect(403);
    expect(regua.sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
  });

  it('sync: executa na requisição e devolve os resultados por etapa (contrato)', async () => {
    const resposta = await executar({
      dataReferencia: '10/09/2026',
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
      sync: true,
    }).expect(200);

    expect(Object.keys(resposta.body as object)).toEqual([
      'executadoEm',
      'resultados',
    ]);
    expect(resposta.body.executadoEm).toBe('sync');
    expect(resposta.body.resultados).toHaveLength(1);
    expect(resposta.body.resultados[0]).toMatchObject({
      tenant: 'MAIS_PRIME',
      tipo: 'D0',
      dataReferencia: '10/09/2026',
      dataAlvo: '10/09/2026',
      gatilho: true,
      dryRun: true,
      execucaoId: null,
      status: 'DRY_RUN',
      origemDados: 'SGA',
      metricas: {
        totalRegistrosSga: 1,
        totalPaginasSga: 1,
        totalBoletosElegiveis: 1,
        totalAssociados: 1,
        totalSemUsuario: 1,
        totalSemToken: 0,
        totalIdempotentes: 0,
        totalDuplicadosUsuario: 0,
        totalEnfileirados: 0,
        totalEnviados: 0,
        totalFalhas: 0,
        totalTokensInvalidos: 0,
        coberturaElegiveis: 0,
      },
      amostraDestinatarios: [],
    });
  });

  it('sync com a régua da base/data já em curso: 409 com code estável, sem varrer o SGA', async () => {
    regua.trava.ocupadas.add(CHAVE);

    const resposta = await executar({
      dataReferencia: '10/09/2026',
      tenants: ['MAIS_PRIME'],
      sync: true,
    }).expect(409);

    expect(resposta.body).toMatchObject({
      statusCode: 409,
      code: 'REGUA_EM_EXECUCAO',
      dataReferencia: '10/09/2026',
      bases: ['MAIS_PRIME'],
    });
    expect(typeof resposta.body.message).toBe('string');
    expect(regua.sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
  });

  it('enfileirada: responde na hora com o job; retry e retenção ficam com o padrão da fila', async () => {
    const resposta = await executar({
      dataReferencia: '10/09/2026',
      tenants: ['MAIS_PRIME'],
      tipos: ['D0', 'D5'],
    }).expect(200);

    expect(resposta.body).toEqual({
      executadoEm: 'queue',
      jobId: 'job-7',
      queue: 'boleto-notificacao',
    });
    expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
    expect(produtor.enfileirar.mock.calls[0]).toEqual([
      'boleto-notificacao',
      'executar-rotina',
      {
        origem: 'MANUAL',
        dataReferencia: '10/09/2026',
        tenants: ['MAIS_PRIME'],
        tipos: ['D0', 'D5'],
        dryRun: false,
      },
    ]);
    expect(regua.sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
  });

  it('data inexistente → 400, nada é executado nem enfileirado', async () => {
    await executar({ dataReferencia: '31/02/2026', sync: true }).expect(400);
    await executar({ dataReferencia: '31/02/2026' }).expect(400);
    expect(produtor.enfileirar).not.toHaveBeenCalled();
    expect(regua.sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
  });
});
