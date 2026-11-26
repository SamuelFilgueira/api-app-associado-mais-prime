import { ForbiddenException } from '@nestjs/common';
import { CacheService } from 'src/infra/cache/cache.service';
import {
  CONFIG_DA_POSICAO,
  ConsultarPosicaoService,
} from 'src/rastreamento/services/consultar-posicao.service';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import {
  montarRastreamento,
  prepararCredenciaisDeTeste,
} from 'src/rastreamento/testing/montar-rastreamento';
import { IntegrationError } from 'src/shared/erros/erros';

/** `yyyy-mm-dd HH:mm:ss` no fuso do processo (formato da M7). */
function dataLocal(instante: number): string {
  const d = new Date(instante);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Consulta de posição: cache curto, memória do provedor do veículo, prazo
 * por provedor e credencial resolvida por provedor.
 */
describe('ConsultarPosicaoService', () => {
  const BASE = 'MAIS_PRIME';
  const CNPJ = '11222333000144';
  const CHASSI = '9BWZZZ377VT004251';
  const MINUTO = 60 * 1000;

  let banco: BancoRastreamentoEmMemoria;
  let m7: { ultimaPosicaoM7: jest.Mock };
  let logica: { ultimaPosicao: jest.Mock };
  let softruck: { ultimaPosicaoSoftruck: jest.Mock };
  let posicao: ConsultarPosicaoService;
  let cache: CacheService;
  let restaurarAmbiente: () => void;

  const daM7 = (haMs = 0) => ({
    data_gps: dataLocal(Date.now() - haMs),
    latitude: '-22.90',
    longitude: '-43.20',
    identificador: 'ABC1D23',
  });
  const daSoftruck = (haMs = 0) => ({
    date: dataLocal(Date.now() - haMs).replace(' ', 'T'),
    latitude: -22.91,
    longitude: -43.21,
    speed: 10,
    plate: 'ABC1D23',
    brandName: 'FIAT',
    modelName: 'UNO',
  });

  function montar(): void {
    const montado = montarRastreamento({
      banco,
      m7,
      logica,
      softruck,
      reverseGeocode: {
        normalizarCoordenada: () => null,
        reverseGeocodeCoordenada: jest.fn(),
      },
    });
    posicao = montado.posicao;
    cache = montado.cache;
  }

  /** Limpa o cache para a próxima consulta ir aos provedores. */
  const expirarCache = () => cache.invalidar(BASE, `pos:${CHASSI}`);
  const consultar = () => posicao.executar(CNPJ, CHASSI, BASE);

  const veiculoComProvedor = (
    provedor: string | null,
    opcoes: { falhas?: number; verificadoHaMs?: number | null } = {},
  ) => {
    const dono = banco.comUsuario();
    return banco.comVeiculo({
      userId: dono.id,
      chassi: CHASSI,
      provedorRastreamento: provedor,
      provedorFalhas: opcoes.falhas ?? 0,
      provedorVerificadoEm:
        opcoes.verificadoHaMs === null
          ? null
          : new Date(Date.now() - (opcoes.verificadoHaMs ?? 1_000)),
    });
  };

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    banco = new BancoRastreamentoEmMemoria();
    m7 = { ultimaPosicaoM7: jest.fn().mockRejectedValue(new Error('sem M7')) };
    logica = {
      ultimaPosicao: jest.fn().mockRejectedValue(new Error('sem Lógica')),
    };
    softruck = {
      ultimaPosicaoSoftruck: jest
        .fn()
        .mockRejectedValue(new Error('sem Softruck')),
    };
    montar();
  });

  afterEach(() => {
    jest.useRealTimers();
    restaurarAmbiente();
  });

  describe('cache curto por base e chassi', () => {
    it('a segunda consulta dentro da janela não chama provedor', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      const primeira = await consultar();
      const segunda = await consultar();

      expect(segunda).toEqual(primeira);
      expect(m7.ultimaPosicaoM7).toHaveBeenCalledTimes(1);
      expect(logica.ultimaPosicao).toHaveBeenCalledTimes(1);
      expect(softruck.ultimaPosicaoSoftruck).toHaveBeenCalledTimes(1);
    });

    it('consultas simultâneas do mesmo chassi fazem uma ida só aos provedores', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      const respostas = await Promise.all([
        consultar(),
        consultar(),
        consultar(),
      ]);

      expect(new Set(respostas.map((r) => r.origem))).toEqual(new Set(['m7']));
      expect(m7.ultimaPosicaoM7).toHaveBeenCalledTimes(1);
    });

    it('o cache é por base: a mesma consulta em outra base vai aos provedores', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await consultar();
      await posicao.executar(CNPJ, CHASSI, 'MAIS_PRIME_RS');

      expect(m7.ultimaPosicaoM7).toHaveBeenCalledTimes(2);
      expect(m7.ultimaPosicaoM7).toHaveBeenLastCalledWith(
        CNPJ,
        CHASSI,
        'MAIS_PRIME_RS',
        false,
      );
    });

    it('erro não fica em cache: a consulta seguinte tenta de novo', async () => {
      await expect(consultar()).rejects.toThrow(
        'Nenhum provedor de rastreamento retornou dados válidos',
      );
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await expect(consultar()).resolves.toMatchObject({ origem: 'm7' });
    });

    it('rastreamento cortado responde 403 mesmo com posição em cache', async () => {
      const veiculo = veiculoComProvedor(null);
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());
      await consultar();

      veiculo.cortarRastreamento = true;

      await expect(consultar()).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a janela do cache fica entre 10 e 20 segundos', () => {
      expect(CONFIG_DA_POSICAO.cacheTtlSeg).toBeGreaterThanOrEqual(10);
      expect(CONFIG_DA_POSICAO.cacheTtlSeg).toBeLessThanOrEqual(20);
    });
  });

  describe('memória do provedor do veículo', () => {
    it('a rodada completa grava o provedor que respondeu', async () => {
      const veiculo = veiculoComProvedor(null, { verificadoHaMs: null });
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await consultar();

      expect(veiculo.provedorRastreamento).toBe('m7');
      expect(veiculo.provedorFalhas).toBe(0);
      expect(veiculo.provedorVerificadoEm).toBeInstanceOf(Date);
    });

    it('o provedor gravado é o único chamado', async () => {
      veiculoComProvedor('m7');
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await expect(consultar()).resolves.toMatchObject({ origem: 'm7' });

      expect(m7.ultimaPosicaoM7).toHaveBeenCalledTimes(1);
      expect(logica.ultimaPosicao).not.toHaveBeenCalled();
      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
    });

    it('provedor gravado falhou: os demais respondem na mesma consulta e a falha é contada', async () => {
      const veiculo = veiculoComProvedor('m7');
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(daSoftruck());

      await expect(consultar()).resolves.toMatchObject({ origem: 'softruck' });

      expect(veiculo.provedorFalhas).toBe(1);
      // Uma falha isolada não troca o provedor do veículo.
      expect(veiculo.provedorRastreamento).toBe('m7');
    });

    it('após falhas seguidas volta a sondar todos e regrava o vencedor', async () => {
      const veiculo = veiculoComProvedor('m7');
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(daSoftruck());

      for (let i = 0; i < CONFIG_DA_POSICAO.limiteDeFalhas; i++) {
        await consultar();
        await expirarCache();
      }
      expect(veiculo.provedorFalhas).toBe(CONFIG_DA_POSICAO.limiteDeFalhas);

      // A M7 voltou. No modo "só o gravado" a Lógica não seria chamada; aqui
      // ela é — prova de que a rodada sondou todos, em paralelo.
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());
      logica.ultimaPosicao.mockClear();

      await expect(consultar()).resolves.toMatchObject({ origem: 'm7' });

      expect(logica.ultimaPosicao).toHaveBeenCalledTimes(1);
      expect(veiculo.provedorRastreamento).toBe('m7');
      expect(veiculo.provedorFalhas).toBe(0);
    });

    it('provedor gravado voltou a responder antes do limite: as falhas zeram', async () => {
      const veiculo = veiculoComProvedor('m7', { falhas: 2 });
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await consultar();

      expect(veiculo.provedorFalhas).toBe(0);
      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
    });

    it('sem UserVehicle para o chassi: sonda todos, como sempre, sem recusar', async () => {
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await expect(consultar()).resolves.toMatchObject({ origem: 'm7' });
      await expirarCache();
      await consultar();

      expect(logica.ultimaPosicao).toHaveBeenCalledTimes(2);
      expect(softruck.ultimaPosicaoSoftruck).toHaveBeenCalledTimes(2);
    });

    it('conferência vencida: os demais são consultados e o mais recente passa a ser o do veículo', async () => {
      // A M7 continua "respondendo", mas com posição parada há 3 h; a
      // Softruck tem a posição viva (rastreador principal desligado).
      const veiculo = veiculoComProvedor('m7', { verificadoHaMs: 2 * MINUTO });
      m7.ultimaPosicaoM7.mockResolvedValue(daM7(180 * MINUTO));
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(daSoftruck());

      await expect(consultar()).resolves.toMatchObject({ origem: 'softruck' });

      expect(veiculo.provedorRastreamento).toBe('softruck');
    });

    it('posição recente e conferência em dia: não consulta os demais', async () => {
      veiculoComProvedor('m7', { verificadoHaMs: 2 * MINUTO });
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await consultar();

      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
    });
  });

  describe('prazo por provedor', () => {
    it('provedor lento não segura a resposta', async () => {
      jest.useFakeTimers();
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());
      // A Softruck não responde nunca.
      softruck.ultimaPosicaoSoftruck.mockReturnValue(new Promise(() => {}));
      let resposta: unknown;
      void consultar().then((r) => (resposta = r));

      await jest.advanceTimersByTimeAsync(
        CONFIG_DA_POSICAO.prazoDaSondagemMs - 100,
      );
      expect(resposta).toBeUndefined();

      await jest.advanceTimersByTimeAsync(200);
      expect(resposta).toMatchObject({ origem: 'm7' });
    });

    it('o prazo da sondagem fica entre 3 e 5 segundos', () => {
      expect(CONFIG_DA_POSICAO.prazoDaSondagemMs).toBeGreaterThanOrEqual(3_000);
      expect(CONFIG_DA_POSICAO.prazoDaSondagemMs).toBeLessThanOrEqual(5_000);
    });

    it('todos rápidos: responde sem esperar o prazo', async () => {
      jest.useFakeTimers();
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      const resposta = consultar();
      await jest.advanceTimersByTimeAsync(0);

      await expect(resposta).resolves.toMatchObject({ origem: 'm7' });
    });

    it('ninguém respondeu no prazo: espera a primeira posição em vez de responder erro', async () => {
      jest.useFakeTimers();
      let responderSoftruck: (v: unknown) => void = () => undefined;
      softruck.ultimaPosicaoSoftruck.mockReturnValue(
        new Promise((resolver) => (responderSoftruck = resolver)),
      );
      let resposta: unknown;
      void consultar().then((r) => (resposta = r));

      await jest.advanceTimersByTimeAsync(
        CONFIG_DA_POSICAO.prazoDaSondagemMs + 5_000,
      );
      expect(resposta).toBeUndefined();

      responderSoftruck(daSoftruck());
      await jest.advanceTimersByTimeAsync(0);
      expect(resposta).toMatchObject({ origem: 'softruck' });
    });

    it('provedor gravado lento: depois do prazo dele, os demais respondem', async () => {
      jest.useFakeTimers();
      const veiculo = veiculoComProvedor('m7');
      m7.ultimaPosicaoM7.mockReturnValue(new Promise(() => {}));
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(daSoftruck());
      let resposta: unknown;
      void consultar().then((r) => (resposta = r));

      await jest.advanceTimersByTimeAsync(
        CONFIG_DA_POSICAO.prazoDoConhecidoMs - 100,
      );
      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(
        200 + CONFIG_DA_POSICAO.prazoDaSondagemMs,
      );
      expect(resposta).toMatchObject({ origem: 'softruck' });
      expect(veiculo.provedorFalhas).toBe(1);
    });
  });

  describe('credencial por provedor', () => {
    it('base sem credencial da Lógica e da Softruck responde pela M7', async () => {
      restaurarAmbiente();
      restaurarAmbiente = prepararCredenciaisDeTeste([
        'LOGICA_TOKEN',
        'USERNAME_SOFTRUCK',
        'PASSWORD_SOFTRUCK',
        'PUBLIC_KEY_SOFTRUCK',
      ]);
      montar();
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await expect(consultar()).resolves.toMatchObject({ origem: 'm7' });

      // Provedor sem credencial fica fora da sondagem, sem derrubar os demais.
      expect(logica.ultimaPosicao).not.toHaveBeenCalled();
      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
    });

    it('a falta do SOFTRUCK_TOKEN (não usado pela API) não tira a Softruck da sondagem', async () => {
      delete process.env.SOFTRUCK_TOKEN;
      softruck.ultimaPosicaoSoftruck.mockResolvedValue(daSoftruck());

      await expect(consultar()).resolves.toMatchObject({ origem: 'softruck' });
    });

    it('provedor gravado que perdeu a credencial: sonda os que restam', async () => {
      restaurarAmbiente();
      restaurarAmbiente = prepararCredenciaisDeTeste(['PUBLIC_KEY_SOFTRUCK']);
      montar();
      veiculoComProvedor('softruck');
      m7.ultimaPosicaoM7.mockResolvedValue(daM7());

      await expect(consultar()).resolves.toMatchObject({ origem: 'm7' });
      expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
    });

    it('nenhum provedor configurado para a base: 503 com code', async () => {
      restaurarAmbiente();
      restaurarAmbiente = prepararCredenciaisDeTeste([
        'MO7_TOKEN',
        'LOGICA_TOKEN',
        'PUBLIC_KEY_SOFTRUCK',
      ]);
      montar();

      const erro = await consultar().catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(IntegrationError);
      expect((erro as IntegrationError).statusHttp).toBe(503);
      expect((erro as IntegrationError).code).toBe(
        'INTEGRACAO_NAO_CONFIGURADA',
      );
    });
  });
});
