import { SgaBoletoPeriodoClient } from 'src/boleto-notificacao/services/sga-boleto-periodo.client';

function boleto(overrides: Record<string, unknown> = {}) {
  return {
    nosso_numero: 1001,
    codigo_associado: 55,
    nome_associado: 'Fulano',
    cpf: '52998224725',
    data_vencimento: '10/03/2026',
    data_vencimento_original: '10/03/2026',
    codigo_situacao_boleto: '2',
    situacao_boleto: 'ABERTO',
    valor_boleto: '99.90',
    mes_referente: '03/2026',
    veiculos: [{ codigo_veiculo: 1, placa: 'ABC1D23' }],
    ...overrides,
  };
}

describe('SgaBoletoPeriodoClient', () => {
  const sgaAuth = { executeRequestWithAuth: jest.fn() };
  const config = {
    get: () => ({
      quantidadePorPagina: 2,
      sgaBaseUrl: 'https://sga.test/api/sga/v2',
      sgaMockFile: undefined,
    }),
  };
  let client: SgaBoletoPeriodoClient;

  beforeEach(() => {
    sgaAuth.executeRequestWithAuth.mockReset();
    client = new SgaBoletoPeriodoClient(sgaAuth as any, config as any);
  });

  describe('parsePagina (parser defensivo)', () => {
    it('normaliza a chave "mostrando " com espaço e coage strings para número', () => {
      const pagina = client.parsePagina({
        'mostrando ': '100',
        numero_paginas: '10',
        total_registros: '3000',
        pagina_corrente: 1,
        boletos: [
          boleto({ codigo_situacao_boleto: 2, codigo_associado: '77' }),
        ],
      });

      expect(pagina.mostrando).toBe(100);
      expect(pagina.numeroPaginas).toBe(10);
      expect(pagina.totalRegistros).toBe(3000);
      expect(pagina.boletos).toHaveLength(1);
      expect(pagina.boletos[0].codigoSituacaoBoleto).toBe('2');
      expect(pagina.boletos[0].codigoAssociado).toBe(77);
      expect(pagina.boletos[0].nossoNumero).toBe('1001');
    });

    it('aceita array puro e retorno vazio', () => {
      expect(client.parsePagina([boleto()]).boletos).toHaveLength(1);
      expect(client.parsePagina(null).boletos).toEqual([]);
      expect(client.parsePagina({ boletos: 'x' }).boletos).toEqual([]);
    });
  });

  describe('listarAbertosPorVencimentoOriginal (paginação)', () => {
    it('itera páginas base-0 até cobrir numero_paginas e envia os parâmetros corretos', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce({
          status: 200,
          data: {
            mostrando: 2,
            numero_paginas: 2,
            total_registros: '3',
            pagina_corrente: 1,
            boletos: [boleto({ nosso_numero: 1 }), boleto({ nosso_numero: 2 })],
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            mostrando: 1,
            numero_paginas: 2,
            total_registros: '3',
            pagina_corrente: 2,
            boletos: [boleto({ nosso_numero: 3 })],
          },
        });

      const resultado = await client.listarAbertosPorVencimentoOriginal(
        'MAIS_PRIME',
        new Date(2026, 2, 10),
      );

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
      const primeiraChamada = sgaAuth.executeRequestWithAuth.mock.calls[0];
      expect(primeiraChamada[0]).toBe('MAIS_PRIME');
      expect(primeiraChamada[1].url).toBe(
        'https://sga.test/api/sga/v2/listar/boleto-associado/periodo',
      );
      expect(primeiraChamada[1].data).toEqual({
        data_vencimento_original_inicial: '10/03/2026',
        data_vencimento_original_final: '10/03/2026',
        codigo_situacao_boleto: 2,
        quantidade_por_pagina: 2,
        inicio_paginacao: 0,
      });
      expect(
        sgaAuth.executeRequestWithAuth.mock.calls[1][1].data.inicio_paginacao,
      ).toBe(1);

      expect(resultado.boletos.map((b) => b.nossoNumero)).toEqual([
        '1',
        '2',
        '3',
      ]);
      expect(resultado.totalRegistros).toBe(3);
      expect(resultado.numeroPaginas).toBe(2);
      expect(resultado.paginasConsultadas).toBe(2);
      expect(resultado.origem).toBe('SGA');
    });

    it('para em página vazia quando os metadados não vêm e descarta duplicados entre páginas', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce({
          status: 200,
          data: {
            boletos: [boleto({ nosso_numero: 1 }), boleto({ nosso_numero: 2 })],
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            boletos: [boleto({ nosso_numero: 2 }), boleto({ nosso_numero: 3 })],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { boletos: [] } });

      const resultado = await client.listarAbertosPorVencimentoOriginal(
        'MAIS_PRIME',
        new Date(2026, 2, 10),
      );

      expect(resultado.boletos.map((b) => b.nossoNumero)).toEqual([
        '1',
        '2',
        '3',
      ]);
      expect(resultado.duplicadosEntrePaginas).toBe(1);
      expect(resultado.paginasConsultadas).toBe(3);
    });

    it('lança erro descritivo em HTTP != 200', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValueOnce({
        status: 500,
        data: { mensagem: 'erro interno' },
      });

      await expect(
        client.listarAbertosPorVencimentoOriginal(
          'MAIS_PRIME',
          new Date(2026, 2, 10),
        ),
      ).rejects.toThrow(/HTTP 500/);
    });
  });
});
