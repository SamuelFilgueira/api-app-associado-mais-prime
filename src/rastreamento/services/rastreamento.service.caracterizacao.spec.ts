import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import {
  montarRastreamento,
  prepararCredenciaisDeTeste,
} from 'src/rastreamento/testing/montar-rastreamento';

/**
 * Caracterização do `RastreamentoService`: o que cada método público devolve
 * e o que ele pede aos provedores. Escrito ANTES da quebra do service e
 * mantido depois — só a função `montar` (construção) acompanha a estrutura.
 *
 * As asserções olham a resposta e o estado gravado, não a forma das
 * consultas ao banco.
 */
describe('RastreamentoService (caracterização)', () => {
  const BASE = 'MAIS_PRIME';
  const CNPJ = '11222333000144';
  const CHASSI = '9BWZZZ377VT004251';

  let banco: BancoRastreamentoEmMemoria;
  let m7: {
    ultimaPosicaoM7: jest.Mock;
    getEventoPadraoM7: jest.Mock;
    ancoraM7: jest.Mock;
    ignicaoM7: jest.Mock;
    renovarToken: jest.Mock;
    processarWebhook: jest.Mock;
  };
  let logica: { ultimaPosicao: jest.Mock };
  let softruck: { ultimaPosicaoSoftruck: jest.Mock };
  let historicoSoftruck: {
    gerarRelatorioPdf: jest.Mock;
    obterRotas: jest.Mock;
  };
  let reverseGeocode: {
    normalizarCoordenada: jest.Mock;
    reverseGeocodeCoordenada: jest.Mock;
  };
  let notifications: { dispararNotificacaoVeiculoWebhook: jest.Mock };
  let service: RastreamentoService;

  const contexto = {
    baseOrigin: BASE,
    logicaToken: 'logica-token',
    logicaTokenKey: 'LOGICA_TOKEN',
    softruckPublicKey: 'softruck-key',
  };

  const posicaoM7 = (dataGps: string) => ({
    monitorado: 10,
    data_gps: dataGps,
    latitude: '-22.90',
    longitude: '-43.20',
    velocidade: 40,
    tensao: '12.4',
    voltagem: 12.4,
    ignicao: true,
    cidade: 'Rio de Janeiro,RJ',
    marca: 'FIAT',
    modelo: 'UNO',
    identificador: 'ABC1D23',
  });

  const posicaoLogica = (ultimaTrasmissao: string) => ({
    oIgnicao: true,
    placa: 'ABC1D23',
    condutorNome: null,
    modelo: 'UNO',
    marca: 'FIAT',
    alertaIgnicao: false,
    cidade: 'Rio de Janeiro',
    endereco: 'Rua A, 10',
    bairro: 'Centro',
    estado: 'RJ',
    latitude: -22.9,
    ultimaTrasmissao,
    direcao: 'N',
    longitude: -43.2,
    ignicao: 'Ligada',
    hodometro: 1000,
    velocidade: 30,
    voltagem: 12.1,
  });

  const posicaoSoftruck = (date: string) => ({
    plate: 'ABC1D23',
    brandName: 'FIAT',
    modelName: 'UNO',
    date,
    latitude: -22.91,
    longitude: -43.21,
    speed: 55,
    ign: true,
    voltagem: 12.8,
    endereco: undefined,
  });

  /**
   * Construção do service — único ponto que acompanha a estrutura interna.
   * Antes da quebra era `new RastreamentoService(prisma, notifications,
   * tokenResolver, softruck, m7, logica, historicoSoftruck, reverseGeocode)`;
   * as credenciais, que vinham de um `TokenResolverService` de mentira, agora
   * são lidas pelos próprios provedores (variáveis de ambiente de teste).
   */
  function montar(): RastreamentoService {
    return montarRastreamento({
      banco,
      m7,
      logica,
      softruck,
      historicoSoftruck,
      reverseGeocode,
      notifications,
    }).service;
  }

  let restaurarAmbiente: () => void;

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    banco = new BancoRastreamentoEmMemoria();
    m7 = {
      ultimaPosicaoM7: jest.fn().mockRejectedValue(new Error('sem M7')),
      getEventoPadraoM7: jest.fn(),
      ancoraM7: jest.fn(),
      ignicaoM7: jest.fn(),
      renovarToken: jest.fn(),
      processarWebhook: jest.fn((payload: unknown) => ({
        sucesso: true,
        mensagem: 'Webhook processado com sucesso',
        dados: { palyload: payload, timestamp_recebimento: 'agora' },
      })),
    };
    logica = {
      ultimaPosicao: jest.fn().mockRejectedValue(new Error('sem Lógica')),
    };
    softruck = {
      ultimaPosicaoSoftruck: jest
        .fn()
        .mockRejectedValue(new Error('sem Softruck')),
    };
    historicoSoftruck = {
      gerarRelatorioPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      obterRotas: jest.fn().mockResolvedValue({ geojson: {} }),
    };
    reverseGeocode = {
      normalizarCoordenada: jest.fn((v?: number | string | null) =>
        v === undefined || v === null ? null : String(v),
      ),
      reverseGeocodeCoordenada: jest.fn().mockResolvedValue('Rua B, Tijuca'),
    };
    notifications = {
      dispararNotificacaoVeiculoWebhook: jest
        .fn()
        .mockResolvedValue({ sent: 1, skipped: 0 }),
    };
    service = montar();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restaurarAmbiente();
  });

  describe('rastreamento (posição unificada)', () => {
    it('devolve a posição mais recente entre os provedores, com a origem', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('2026-08-31 10:00:00'));
      logica.ultimaPosicao.mockResolvedValue(
        posicaoLogica('31/08/2026 12:30:00'),
      );

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta).toEqual({
        ...posicaoLogica('31/08/2026 12:30:00'),
        origem: 'logica',
      });
    });

    it('responde com a M7 no formato da M7 quando só ela tem o veículo', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('2026-08-31 10:00:00'));

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta).toEqual({
        ...posicaoM7('2026-08-31 10:00:00'),
        origem: 'm7',
      });
      expect(reverseGeocode.reverseGeocodeCoordenada).not.toHaveBeenCalled();
    });

    it('M7 tem prioridade sobre a Softruck quando a diferença é de até 1h', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('2026-08-31 10:00:00'));
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(
        posicaoSoftruck('2026-08-31T10:59:00'),
      );

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta.origem).toBe('m7');
    });

    it('Softruck vence quando está mais de 1h à frente da M7', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('2026-08-31 10:00:00'));
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(
        posicaoSoftruck('2026-08-31T11:00:01'),
      );

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta.origem).toBe('softruck');
    });

    it('Softruck vencedora sai no formato unificado e com o endereço do reverse geocode', async () => {
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(
        posicaoSoftruck('2026-08-31T11:00:01'),
      );

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta).toEqual({
        ...posicaoSoftruck('2026-08-31T11:00:01'),
        placa: 'ABC1D23',
        marca: 'FIAT',
        modelo: 'UNO',
        ultimaTrasmissao: '2026-08-31T11:00:01',
        data_gps: '2026-08-31T11:00:01',
        velocidade: 55,
        ignicao: true,
        condutorNome: null,
        alertaIgnicao: false,
        cidade: null,
        endereco: 'Rua B, Tijuca',
        bairro: null,
        estado: null,
        direcao: null,
        hodometro: null,
        voltagem: 12.8,
        identificador: 'ABC1D23',
        origem: 'softruck',
      });
      expect(reverseGeocode.reverseGeocodeCoordenada).toHaveBeenCalledWith(
        '-22.91',
        '-43.21',
        BASE,
      );
    });

    it('falha do reverse geocode não derruba a posição da Softruck', async () => {
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(
        posicaoSoftruck('2026-08-31T11:00:01'),
      );
      reverseGeocode.reverseGeocodeCoordenada.mockRejectedValue(
        new Error('nominatim fora'),
      );

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta.origem).toBe('softruck');
      expect(resposta.endereco).toBeNull();
    });

    it('provedor com data inválida é ignorado; os demais respondem', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('data-invalida'));
      logica.ultimaPosicao.mockResolvedValue(
        posicaoLogica('31/08/2026 09:00:00'),
      );

      const resposta = await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(resposta.origem).toBe('logica');
    });

    it('nenhum provedor com dados → erro (500 genérico no filtro global)', async () => {
      await expect(
        service.rastreamento(CNPJ, CHASSI, contexto),
      ).rejects.toThrow(
        'Nenhum provedor de rastreamento retornou dados válidos',
      );
    });

    it('cada provedor é chamado com a base da requisição', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('2026-08-31 10:00:00'));

      await service.rastreamento(CNPJ, CHASSI, contexto);

      expect(m7.ultimaPosicaoM7).toHaveBeenCalledWith(
        CNPJ,
        CHASSI,
        BASE,
        false,
      );
      expect(logica.ultimaPosicao).toHaveBeenCalledWith(
        CHASSI,
        'logica-token',
        { baseOrigin: BASE, tokenKey: 'LOGICA_TOKEN' },
      );
      expect(softruck.ultimaPosicaoSoftruck).toHaveBeenCalledWith(
        CHASSI,
        BASE,
        'softruck-key',
        undefined,
        false,
      );
    });

    it('veículo com rastreamento cortado → 403 e nenhum provedor consultado', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({
        userId: dono.id,
        chassi: CHASSI,
        cortarRastreamento: true,
      });

      await expect(
        service.rastreamento(CNPJ, CHASSI, contexto),
      ).rejects.toEqual(
        new ForbiddenException(
          `Rastreamento bloqueado para o veículo com chassi ${CHASSI}.`,
        ),
      );
      expect(m7.ultimaPosicaoM7).not.toHaveBeenCalled();
      expect(logica.ultimaPosicao).not.toHaveBeenCalled();
      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
    });
  });

  describe('posição por provedor', () => {
    it('ultimaPosicaoM7 devolve o que a M7 respondeu', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(posicaoM7('2026-08-31 10:00:00'));

      await expect(
        service.ultimaPosicaoM7(CNPJ, CHASSI, BASE),
      ).resolves.toEqual(posicaoM7('2026-08-31 10:00:00'));
      expect(m7.ultimaPosicaoM7).toHaveBeenCalledWith(CNPJ, CHASSI, BASE);
    });

    it.each([
      ['ultimaPosicaoM7', () => service.ultimaPosicaoM7(CNPJ, CHASSI, BASE)],
      [
        'ultimaPosicaoLogica',
        () => service.ultimaPosicaoLogica(CHASSI, 'logica-token'),
      ],
      [
        'ultimaPosicaoSoftruck',
        () => service.ultimaPosicaoSoftruck(CHASSI, BASE, 'softruck-key'),
      ],
    ])('%s respeita o corte do rastreamento (403)', async (_nome, chamar) => {
      const dono = banco.comUsuario();
      banco.comVeiculo({
        userId: dono.id,
        chassi: CHASSI,
        cortarRastreamento: true,
      });

      await expect(chamar()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('âncora e ignição', () => {
    const respostaOk = {
      mensagem: 'ok',
      monitorado: 10,
      ancora_ativa: 1,
      evt_ign: 0,
      evg_ign_exec: 0,
      ancora_lat: -22.9,
      ancora_lng: -43.2,
    };

    it('ancoraM7 manda a âncora pedida com o estado atual da ignição e grava no usuário', async () => {
      const dono = banco.comUsuario({ notificacaoIgnicao: true });
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });
      m7.ancoraM7.mockResolvedValue(respostaOk);

      const resposta = await service.ancoraM7(CNPJ, CHASSI, true, BASE);

      expect(resposta).toEqual(respostaOk);
      expect(m7.ancoraM7).toHaveBeenCalledWith(CNPJ, CHASSI, true, true, BASE);
      expect(banco.usuario(dono.id)?.ancoraAtiva).toBe(true);
      expect(m7.getEventoPadraoM7).not.toHaveBeenCalled();
    });

    it('ignicaoM7 manda o alerta pedido com o estado atual da âncora e grava no usuário', async () => {
      const dono = banco.comUsuario({ ancoraAtiva: true });
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });
      m7.ignicaoM7.mockResolvedValue(respostaOk);

      const resposta = await service.ignicaoM7(CNPJ, CHASSI, true, BASE);

      expect(resposta).toEqual(respostaOk);
      expect(m7.ignicaoM7).toHaveBeenCalledWith(CNPJ, CHASSI, true, true, BASE);
      expect(banco.usuario(dono.id)?.notificacaoIgnicao).toBe(true);
    });

    it('resposta da M7 com `erro` é devolvida como veio e nada é gravado', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });
      m7.ancoraM7.mockResolvedValue({ erro: 'veículo sem rastreador' });

      await expect(service.ancoraM7(CNPJ, CHASSI, true, BASE)).resolves.toEqual(
        { erro: 'veículo sem rastreador' },
      );
      expect(banco.usuario(dono.id)?.ancoraAtiva).toBe(false);
    });

    it('chassi sem vínculo local: usa o estado da M7 e não recusa', async () => {
      m7.getEventoPadraoM7.mockResolvedValue({
        ancoraAtiva: false,
        evtIgn: true,
      });
      m7.ancoraM7.mockResolvedValue(respostaOk);

      await expect(service.ancoraM7(CNPJ, CHASSI, true, BASE)).resolves.toEqual(
        respostaOk,
      );
      expect(m7.getEventoPadraoM7).toHaveBeenCalledWith(CNPJ, CHASSI, BASE);
      expect(m7.ancoraM7).toHaveBeenCalledWith(CNPJ, CHASSI, true, true, BASE);
    });

    it.each([
      ['true', true],
      ['1', true],
      [1, true],
      ['false', false],
      [0, false],
    ])('ignicaoM7 aceita evt_ign=%p', async (entrada, esperado) => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });
      m7.ignicaoM7.mockResolvedValue(respostaOk);

      await service.ignicaoM7(CNPJ, CHASSI, entrada as never, BASE);

      expect(m7.ignicaoM7).toHaveBeenCalledWith(
        CNPJ,
        CHASSI,
        esperado,
        false,
        BASE,
      );
    });

    it('ignicaoM7 com evt_ign inválido → 400 e nada vai à M7', async () => {
      await expect(
        service.ignicaoM7(CNPJ, CHASSI, 'talvez' as never, BASE),
      ).rejects.toEqual(
        new BadRequestException(
          'Campo evt_ign inválido. Use true/false ou 1/0.',
        ),
      );
      expect(m7.ignicaoM7).not.toHaveBeenCalled();
    });

    it('comando em veículo com rastreamento cortado → 403', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({
        userId: dono.id,
        chassi: CHASSI,
        cortarRastreamento: true,
      });

      await expect(
        service.ancoraM7(CNPJ, CHASSI, true, BASE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(m7.ancoraM7).not.toHaveBeenCalled();
    });

    it('getAncoraStatus devolve o estado e o dono; sem vínculo, falso e null', async () => {
      const dono = banco.comUsuario({ ancoraAtiva: true });
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });

      await expect(service.getAncoraStatus(CHASSI)).resolves.toEqual({
        ancoraAtiva: true,
        userId: dono.id,
      });
      await expect(service.getAncoraStatus('OUTRO')).resolves.toEqual({
        ancoraAtiva: false,
        userId: null,
      });
    });

    it('getIgnicaoStatus devolve o estado e o dono; sem vínculo, falso e null', async () => {
      const dono = banco.comUsuario({ notificacaoIgnicao: true });
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });

      await expect(service.getIgnicaoStatus(` ${CHASSI} `)).resolves.toEqual({
        notificacaoIgnicao: true,
        userId: dono.id,
      });
      await expect(service.getIgnicaoStatus('OUTRO')).resolves.toEqual({
        notificacaoIgnicao: false,
        userId: null,
      });
    });

    it('getIgnicaoStatus ignora veículo ou dono inativo', async () => {
      const dono = banco.comUsuario({
        notificacaoIgnicao: true,
        isActive: false,
      });
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });

      await expect(service.getIgnicaoStatus(CHASSI)).resolves.toEqual({
        notificacaoIgnicao: false,
        userId: null,
      });
    });

    it('getIgnicaoStatus sem chassi → 400', async () => {
      await expect(service.getIgnicaoStatus('  ')).rejects.toEqual(
        new BadRequestException('Chassi é obrigatório'),
      );
    });
  });

  describe('histórico Softruck', () => {
    it('valida os parâmetros com as mensagens de sempre', async () => {
      await expect(
        service.obterRotasHistoricoSoftruck(
          ' ',
          '2026-08-01',
          '2026-08-02',
          BASE,
          'softruck-key',
        ),
      ).rejects.toEqual(
        new BadRequestException('Parâmetro chassi é obrigatório'),
      );
      await expect(
        service.obterRotasHistoricoSoftruck(
          CHASSI,
          '01/08/2026',
          '2026-08-02',
          BASE,
          'softruck-key',
        ),
      ).rejects.toEqual(
        new BadRequestException(
          'Parâmetro dataInicial inválido. Use o formato yyyy-mm-dd',
        ),
      );
      await expect(
        service.gerarRelatorioHistoricoSoftruckPDF(
          CHASSI,
          '2026-08-01',
          '2026-02-30',
          BASE,
          'softruck-key',
        ),
      ).rejects.toEqual(
        new BadRequestException(
          'Parâmetro dataFinal inválido. Use o formato yyyy-mm-dd',
        ),
      );
      await expect(
        service.gerarRelatorioHistoricoSoftruckPDF(
          CHASSI,
          '2026-08-03',
          '2026-08-02',
          BASE,
          'softruck-key',
        ),
      ).rejects.toEqual(
        new BadRequestException(
          'Parâmetro dataInicial não pode ser maior que dataFinal',
        ),
      );
    });

    it('delega com os parâmetros normalizados', async () => {
      await service.obterRotasHistoricoSoftruck(
        ` ${CHASSI} `,
        '2026-08-01',
        '2026-08-02',
        BASE,
        'softruck-key',
      );
      const pdf = await service.gerarRelatorioHistoricoSoftruckPDF(
        CHASSI,
        '2026-08-01',
        '2026-08-02',
        BASE,
        'softruck-key',
      );

      expect(historicoSoftruck.obterRotas).toHaveBeenCalledWith(
        CHASSI,
        '2026-08-01',
        '2026-08-02',
        BASE,
        'softruck-key',
      );
      expect(historicoSoftruck.gerarRelatorioPdf).toHaveBeenCalledWith(
        CHASSI,
        '2026-08-01',
        '2026-08-02',
        BASE,
        'softruck-key',
      );
      expect(pdf).toEqual(Buffer.from('pdf'));
    });
  });

  describe('webhook M7', () => {
    const evento = {
      codigo: '900001',
      chassi: CHASSI,
      monitorado: '10',
      evento: 'Ignição Ligada',
      tipoevento: 32,
      titulo: 'Alerta',
      canal: { identificacao: 'x', nome: 'y' },
      enviado_em: '2026-08-31T13:00:00.000Z',
      scope: 'cliente',
    };

    it('grava o evento, aciona a notificação e devolve o envelope da M7', async () => {
      const dono = banco.comUsuario({ notificacaoIgnicao: true });
      banco.comVeiculo({ userId: dono.id, chassi: CHASSI });

      const retorno = await service.processarWebhookM7(evento);

      expect(banco.eventos).toHaveLength(1);
      expect(banco.eventos[0]).toMatchObject({
        chassi: CHASSI,
        evento: 'Ignição Ligada',
        tipoevento: 32,
        provider: 'M7',
        payload: JSON.stringify(evento),
      });
      // O 4º argumento (chave do evento) entrou com a idempotência do
      // webhook; os três primeiros são os de sempre.
      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).toHaveBeenCalledWith(CHASSI, 32, 'Ignição Ligada', {
        chaveDoEvento: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(retorno).toMatchObject({
        sucesso: true,
        mensagem: 'Webhook processado com sucesso',
        dados: { palyload: evento },
      });
    });

    it('payload sem chassi não grava nem notifica', async () => {
      await service.processarWebhookM7({ teste: 'ping' });

      expect(banco.eventos).toHaveLength(0);
      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).not.toHaveBeenCalled();
    });
  });

  it('renovarTokenM7 informa o resultado por base sem devolver o token', async () => {
    m7.renovarToken.mockResolvedValue({ token: 'SEGREDO', expires_in: 3600 });

    const resposta = await service.renovarTokenM7();

    expect(Object.keys(resposta).length).toBeGreaterThan(0);
    for (const porBase of Object.values(resposta)) {
      expect(porBase).toEqual({ renovado: true, expires_in: 3600 });
    }
  });
});
