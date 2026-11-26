import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import {
  montarRastreamento,
  prepararCredenciaisDeTeste,
} from 'src/rastreamento/testing/montar-rastreamento';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

/**
 * Sem base válida o rastreamento falha (`BaseNaoResolvidaError`) antes de
 * falar com qualquer provedor. Antes caía em silêncio na base padrão.
 */
describe('RastreamentoService (base não resolvida)', () => {
  let banco: BancoRastreamentoEmMemoria;
  let m7: {
    getEventoPadraoM7: jest.Mock;
    ancoraM7: jest.Mock;
    ignicaoM7: jest.Mock;
    ultimaPosicaoM7: jest.Mock;
  };
  let logica: { ultimaPosicao: jest.Mock };
  let softruck: { ultimaPosicaoSoftruck: jest.Mock };
  let service: RastreamentoService;
  let restaurarAmbiente: () => void;

  const nenhumProvedorChamado = () => {
    expect(m7.ultimaPosicaoM7).not.toHaveBeenCalled();
    expect(logica.ultimaPosicao).not.toHaveBeenCalled();
    expect(softruck.ultimaPosicaoSoftruck).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    banco = new BancoRastreamentoEmMemoria();
    m7 = {
      getEventoPadraoM7: jest
        .fn()
        .mockResolvedValue({ ancoraAtiva: false, evtIgn: true }),
      ancoraM7: jest.fn().mockResolvedValue({ erro: 'simulado' }),
      ignicaoM7: jest.fn().mockResolvedValue({ erro: 'simulado' }),
      ultimaPosicaoM7: jest.fn(),
    };
    logica = { ultimaPosicao: jest.fn() };
    softruck = { ultimaPosicaoSoftruck: jest.fn() };

    service = montarRastreamento({ banco, m7, logica, softruck }).service;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restaurarAmbiente();
  });

  describe('estado do veículo consultado na M7 (âncora/ignição)', () => {
    it.each([
      [
        'ancoraM7',
        () => service.ancoraM7('cnpj', 'CHASSI', true, undefined as never),
      ],
      [
        'ignicaoM7',
        () => service.ignicaoM7('cnpj', 'CHASSI', true, undefined as never),
      ],
    ])(
      '%s sem base → BaseNaoResolvidaError e nenhuma chamada à M7',
      async (_metodo, chamar) => {
        await expect(chamar()).rejects.toBeInstanceOf(BaseNaoResolvidaError);

        expect(m7.getEventoPadraoM7).not.toHaveBeenCalled();
        expect(m7.ancoraM7).not.toHaveBeenCalled();
        expect(m7.ignicaoM7).not.toHaveBeenCalled();
      },
    );

    it('com base, consulta o estado na M7 com a base recebida', async () => {
      await service.ancoraM7('cnpj', 'CHASSI', true, 'MAIS_PRIME_RS');

      expect(m7.getEventoPadraoM7).toHaveBeenCalledWith(
        'cnpj',
        'CHASSI',
        'MAIS_PRIME_RS',
      );
      expect(m7.ancoraM7).toHaveBeenCalledWith(
        'cnpj',
        'CHASSI',
        true,
        true,
        'MAIS_PRIME_RS',
      );
    });
  });

  describe('rastreamento sem contexto de requisição (base do dono do veículo)', () => {
    const comDono = (baseOrigin: string | null) => {
      const dono = banco.comUsuario({ baseOrigin });
      banco.comVeiculo({ userId: dono.id, chassi: 'CHASSI' });
    };

    it.each([
      ['veículo sem dono no cadastro', () => undefined],
      ['dono sem base', () => comDono(null)],
      ['dono com base de outro deploy', () => comDono('OUTRA')],
    ])(
      '%s → BaseNaoResolvidaError e nenhum provedor consultado',
      async (_caso, preparar) => {
        preparar();

        await expect(
          service.rastreamento('cnpj', 'CHASSI'),
        ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

        nenhumProvedorChamado();
      },
    );

    it('falha de banco propaga como está (não vira "base não resolvida")', async () => {
      const falha = new Error('conexão recusada');
      banco.falharNaProxima('userVehicle', falha);

      await expect(service.rastreamento('cnpj', 'CHASSI')).rejects.toBe(falha);

      nenhumProvedorChamado();
    });

    it('usa a base do dono do veículo em todos os provedores', async () => {
      comDono('MAIS_PRIME_RS');
      m7.ultimaPosicaoM7.mockResolvedValue({
        data_gps: '2026-08-31 10:00:00',
        latitude: '-8.05',
        longitude: '-34.9',
      });
      logica.ultimaPosicao.mockRejectedValue(new Error('sem rastreador'));
      softruck.ultimaPosicaoSoftruck.mockRejectedValue(
        new Error('sem rastreador'),
      );

      const resposta = await service.rastreamento('cnpj', 'CHASSI');

      expect(resposta.origem).toBe('m7');
      expect(m7.ultimaPosicaoM7).toHaveBeenCalledWith(
        'cnpj',
        'CHASSI',
        'MAIS_PRIME_RS',
        false,
      );
      // A credencial de cada provedor é a da base do dono (sufixo `_RS`).
      expect(logica.ultimaPosicao).toHaveBeenCalledWith(
        'CHASSI',
        'logica-token',
        { baseOrigin: 'MAIS_PRIME_RS', tokenKey: 'LOGICA_TOKEN_RS' },
      );
      expect(softruck.ultimaPosicaoSoftruck).toHaveBeenCalledWith(
        'CHASSI',
        'MAIS_PRIME_RS',
        'softruck-key',
        undefined,
        false,
      );
    });
  });
});
