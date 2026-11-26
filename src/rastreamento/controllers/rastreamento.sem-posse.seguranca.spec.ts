import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
} from 'src/infra/auth/testing/jwt-de-teste';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import {
  montarRastreamento,
  prepararCredenciaisDeTeste,
} from 'src/rastreamento/testing/montar-rastreamento';

/**
 * DECISÃO DO DONO DO PROJETO: o rastreamento NÃO checa posse do veículo.
 *
 * Este spec é a prova de que nenhuma rota de rastreamento passou a amarrar o
 * chassi ao usuário logado: um associado consulta e comanda um chassi que
 * pertence a OUTRO associado e recebe a resposta normal. Guards reais (JWT de
 * verdade), controller real e os casos de uso reais — só os clients dos
 * provedores e o banco são dublês.
 *
 * Se alguém acrescentar guard, filtro ou validação de posse, este spec quebra.
 */
describe('Rastreamento — sem checagem de posse (segurança)', () => {
  const CNPJ = '11222333000144';
  const CHASSI_DO_OUTRO = '9BWZZZ377VT004251';

  let app: INestApplication;
  let banco: BancoRastreamentoEmMemoria;
  let restaurarAmbiente: () => void;
  let donoId: number;
  let curiosoId: number;

  const posicaoM7 = {
    monitorado: 10,
    data_gps: '2026-08-31 10:00:00',
    latitude: '-22.90',
    longitude: '-43.20',
    velocidade: 40,
    ignicao: true,
    cidade: 'Rio de Janeiro,RJ',
    marca: 'FIAT',
    modelo: 'UNO',
    identificador: 'ABC1D23',
  };
  const respostaDoComando = {
    mensagem: 'ok',
    monitorado: 10,
    ancora_ativa: 1,
    evt_ign: 1,
    evg_ign_exec: 0,
    ancora_lat: -22.9,
    ancora_lng: -43.2,
  };

  const m7 = {
    ultimaPosicaoM7: jest.fn(),
    ancoraM7: jest.fn(),
    ignicaoM7: jest.fn(),
    getEventoPadraoM7: jest.fn(),
  };
  const logica = { ultimaPosicao: jest.fn() };
  const softruck = { ultimaPosicaoSoftruck: jest.fn() };

  /** Token de um associado que NÃO é o dono do veículo. */
  const doCurioso = () =>
    bearer(tokenDoApp({ id: curiosoId, cpf: '52998224725' }));
  const http = () => clienteHttp(app);

  beforeAll(async () => {
    prepararSegredoDeTeste();
    restaurarAmbiente = prepararCredenciaisDeTeste();
    banco = new BancoRastreamentoEmMemoria();

    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [RastreamentoController],
      providers: [
        ...AUTENTICACAO_DE_TESTE.providers,
        {
          provide: RastreamentoService,
          useFactory: () =>
            montarRastreamento({
              banco,
              m7,
              logica,
              softruck,
              reverseGeocode: { normalizarCoordenada: () => null },
            }).service,
        },
        { provide: getQueueToken(WEBHOOK_QUEUE), useValue: { add: jest.fn() } },
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
    restaurarAmbiente();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    banco.usuarios = [];
    banco.veiculos = [];
    banco.comandos = [];
    donoId = banco.comUsuario({ ancoraAtiva: true }).id;
    curiosoId = banco.comUsuario().id;
    banco.comVeiculo({ userId: donoId, chassi: CHASSI_DO_OUTRO });

    m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7);
    m7.ancoraM7.mockResolvedValue(respostaDoComando);
    m7.ignicaoM7.mockResolvedValue(respostaDoComando);
    logica.ultimaPosicao.mockRejectedValue(new Error('sem Lógica'));
    softruck.ultimaPosicaoSoftruck.mockRejectedValue(new Error('sem Softruck'));
  });

  it('POST /rastreamento: posição de chassi que não é do associado → resposta normal', async () => {
    const resposta = await http()
      .post('/rastreamento')
      .set(doCurioso())
      .send({ cnpj: CNPJ, chassi: CHASSI_DO_OUTRO })
      .expect(201);

    expect(resposta.body).toEqual({ ...posicaoM7, origem: 'm7' });
  });

  it('POST /rastreamento: chassi sem nenhum vínculo local → resposta normal', async () => {
    const resposta = await http()
      .post('/rastreamento')
      .set(doCurioso())
      .send({ cnpj: CNPJ, chassi: 'CHASSISEMVINCULO01' })
      .expect(201);

    expect(resposta.body).toMatchObject({ origem: 'm7' });
  });

  it('POST /rastreamento/ultima-posicao: idem', async () => {
    const resposta = await http()
      .post('/rastreamento/ultima-posicao')
      .set(doCurioso())
      .send({ cnpj: CNPJ, chassi: CHASSI_DO_OUTRO })
      .expect(201);

    expect(resposta.body).toEqual(posicaoM7);
  });

  it('GET /rastreamento/ancora-status e /ignicao-status: estado do veículo de outro associado', async () => {
    const ancora = await http()
      .get('/rastreamento/ancora-status')
      .query({ chassi: CHASSI_DO_OUTRO })
      .set(doCurioso())
      .expect(200);
    const ignicao = await http()
      .get('/rastreamento/ignicao-status')
      .query({ chassi: CHASSI_DO_OUTRO })
      .set(doCurioso())
      .expect(200);

    // Mesmo formato de sempre: o estado e o id do dono do vínculo.
    expect(ancora.body).toEqual({ ancoraAtiva: true, userId: donoId });
    expect(ignicao.body).toEqual({ notificacaoIgnicao: false, userId: donoId });
  });

  it('POST /rastreamento/ancora-m7 e /ignicao-m7: comando em chassi de outro associado é aceito', async () => {
    const ancora = await http()
      .post('/rastreamento/ancora-m7')
      .set(doCurioso())
      .send({ cnpj: CNPJ, chassi: CHASSI_DO_OUTRO, ancora_ativa: false })
      .expect(201);
    const ignicao = await http()
      .post('/rastreamento/ignicao-m7')
      .set(doCurioso())
      .send({ cnpj: CNPJ, chassi: CHASSI_DO_OUTRO, evt_ign: true })
      .expect(201);

    expect(ancora.body).toEqual(respostaDoComando);
    expect(ignicao.body).toEqual(respostaDoComando);
    expect(banco.veiculo(CHASSI_DO_OUTRO)).toMatchObject({
      ancoraAtiva: false,
      notificacaoIgnicao: true,
    });
    // A auditoria registra QUEM comandou — sem recusar.
    expect(
      banco.comandos.map((c) => [c.userId, c.comando, c.resultado]),
    ).toEqual([
      [curiosoId, 'ANCORA', 'OK'],
      [curiosoId, 'IGNICAO', 'OK'],
    ]);
  });

  it('a autenticação continua exigida: sem token → 401', async () => {
    await http()
      .post('/rastreamento')
      .send({ cnpj: CNPJ, chassi: CHASSI_DO_OUTRO })
      .expect(401);
    await http()
      .get('/rastreamento/ancora-status')
      .query({ chassi: CHASSI_DO_OUTRO })
      .expect(401);
  });

  it('a única recusa por veículo é o corte feito pelo painel (403), para qualquer usuário', async () => {
    banco.veiculos[0].cortarRastreamento = true;

    const resposta = await http()
      .post('/rastreamento')
      .set(bearer(tokenDoApp({ id: donoId, cpf: '11144477735' })))
      .send({ cnpj: CNPJ, chassi: CHASSI_DO_OUTRO })
      .expect(403);

    expect(resposta.body.message).toBe(
      `Rastreamento bloqueado para o veículo com chassi ${CHASSI_DO_OUTRO}.`,
    );
  });
});
