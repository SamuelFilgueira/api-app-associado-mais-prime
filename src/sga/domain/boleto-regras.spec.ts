import { BoletoReativacaoRetryConfig } from 'src/sga/config/boleto-reativacao-retry.config';
import {
  BoletoVerificacaoConfig,
  INTERVALO_BASE_MS,
} from 'src/sga/config/boleto-verificacao.config';
import {
  descricaoDoBoleto,
  montarCadastroDoBoleto,
} from 'src/sga/domain/boleto-cadastro';
import {
  BOLETO_LEASE_MS,
  decidirAposFalha,
  estadosQuePermitemGerar,
  inicioDaJanelaDeRetry,
  motivoDaFalha,
  tentativaVencida,
  truncarErro,
} from 'src/sga/domain/boleto-geracao';
import {
  estadoDoBoleto,
  proximaConsultaEm,
} from 'src/sga/domain/boleto-situacao';
import {
  ehChassiValido,
  ehCodigoSgaValido,
} from 'src/sga/domain/parametros-sga';
import {
  listaDeVeiculosDoSga,
  removerVeiculosInativos,
  veiculoInativoNoSga,
} from 'src/sga/domain/veiculo-sga';

const MIN = 60_000;
const HORA = 3_600_000;
const DIA = 86_400_000;

describe('regras puras do boleto de reativação', () => {
  describe('situação do boleto no SGA', () => {
    it.each([
      ['1', 'PAGO'],
      ['4', 'PAGO'],
      ['3', 'ENCERRADO'],
      ['999', 'ENCERRADO'],
      ['2', 'EM_ABERTO'],
      ['7', 'EM_ABERTO'],
      [undefined, 'EM_ABERTO'],
    ])('situação %s → %s', (codigo, estado) => {
      expect(estadoDoBoleto(codigo)).toBe(estado);
    });
  });

  describe('próxima consulta pela idade do boleto', () => {
    const config: BoletoVerificacaoConfig = {
      intervaloBaseMs: INTERVALO_BASE_MS,
      maxDias: 30,
      intervaloApos24hMin: 10,
      intervaloApos7dMin: 60,
      espacamentoMs: 0,
    };
    const agora = Date.UTC(2026, 10, 26, 12);

    it.each([
      ['recém-criado', 5 * MIN, 2 * MIN],
      ['23 h', 23 * HORA, 2 * MIN],
      ['2 dias', 2 * DIA, 10 * MIN],
      ['10 dias', 10 * DIA, 60 * MIN],
    ])('boleto de %s: daqui a %i ms', (_caso, idade, intervalo) => {
      expect(
        proximaConsultaEm(config, { criadoEm: agora - idade, agora }),
      ).toEqual(new Date(agora + intervalo));
    });
  });

  describe('geração: quem pode tentar e quando', () => {
    it('a aprovação inicia de qualquer estado, menos GERADO; manual e retry só de quem já passou pelo fluxo', () => {
      expect(estadosQuePermitemGerar('APROVACAO')).toEqual([
        'NAO_GERADO',
        'PENDENTE_RETRY',
        'FALHA',
      ]);
      expect(estadosQuePermitemGerar('MANUAL')).toEqual([
        'PENDENTE_RETRY',
        'FALHA',
      ]);
      expect(estadosQuePermitemGerar('RETRY')).toEqual(['PENDENTE_RETRY']);
      for (const origem of ['APROVACAO', 'MANUAL', 'RETRY'] as const) {
        expect(estadosQuePermitemGerar(origem)).not.toContain('GERADO');
      }
    });

    it('tentativa vencida: sem data conta como vencida', () => {
      const agora = new Date('2026-11-26T12:00:00Z');
      expect(tentativaVencida(null, agora)).toBe(true);
      expect(tentativaVencida(new Date(agora.getTime() - 1), agora)).toBe(true);
      expect(tentativaVencida(agora, agora)).toBe(true);
      expect(tentativaVencida(new Date(agora.getTime() + 1), agora)).toBe(
        false,
      );
    });

    it('o lease cobre com folga o timeout do boleto/cadastrar (60 s)', () => {
      expect(BOLETO_LEASE_MS).toBeGreaterThanOrEqual(5 * 60_000);
    });
  });

  describe('janela de retry', () => {
    const config: BoletoReativacaoRetryConfig = {
      intervaloMin: 5,
      maxHoras: 24,
      janelaVencimentoDias: 45,
    };
    const agora = new Date('2026-11-26T12:00:00Z');
    const haDuasHoras = new Date(agora.getTime() - 2 * HORA);

    it('continua a janela quando o retry encontra PENDENTE_RETRY; manual e outros estados reiniciam', () => {
      expect(
        inicioDaJanelaDeRetry({
          origem: 'RETRY',
          statusAnterior: 'PENDENTE_RETRY',
          retryInicioEm: haDuasHoras,
          agora,
        }),
      ).toBe(haDuasHoras);
      expect(
        inicioDaJanelaDeRetry({
          origem: 'MANUAL',
          statusAnterior: 'PENDENTE_RETRY',
          retryInicioEm: haDuasHoras,
          agora,
        }),
      ).toBe(agora);
      expect(
        inicioDaJanelaDeRetry({
          origem: 'APROVACAO',
          statusAnterior: 'NAO_GERADO',
          retryInicioEm: null,
          agora,
        }),
      ).toBe(agora);
    });

    it('instabilidade dentro da janela: nova tentativa em `intervaloMin`', () => {
      expect(
        decidirAposFalha({
          instabilidade: true,
          inicioDaJanela: haDuasHoras,
          agora,
          config,
        }),
      ).toEqual({
        acao: 'RETENTAR',
        proximaTentativaEm: new Date(agora.getTime() + 5 * MIN),
      });
    });

    it('instabilidade com a janela esgotada: FALHA', () => {
      expect(
        decidirAposFalha({
          instabilidade: true,
          inicioDaJanela: new Date(agora.getTime() - 24 * HORA),
          agora,
          config,
        }),
      ).toEqual({ acao: 'FALHAR', esgotou: true });
    });

    it('erro definitivo: FALHA na hora, sem olhar a janela', () => {
      expect(
        decidirAposFalha({
          instabilidade: false,
          inicioDaJanela: agora,
          agora,
          config,
        }),
      ).toEqual({ acao: 'FALHAR', esgotou: false });
    });

    it('motivo e truncamento do erro gravado', () => {
      expect(motivoDaFalha('HTTP 502', true, config)).toBe(
        'Janela de retry esgotada (24h). Último erro: HTTP 502',
      );
      expect(motivoDaFalha('placa inexistente', false, config)).toBe(
        'placa inexistente',
      );
      expect(truncarErro('x'.repeat(600))).toHaveLength(500);
    });
  });

  describe('corpo do boleto/cadastrar', () => {
    const base = {
      associado: { codigoAssociado: 10, codigoRegional: 3 },
      produtos: {
        valorTotalProdutosAtivo: 100,
        taxaAdministrativa: '-10.50',
        codigoVeiculo: '555',
      },
      codigos: { codigoConta: 27, codigoTipoBoleto: 2 },
      agora: new Date(2026, 10, 30, 15), // 30/11/2026
    };

    it('valor = produtos + taxa (negativa), vencimento no dia seguinte e mês corrente', () => {
      expect(montarCadastroDoBoleto(base)).toEqual({
        codigo_associado: 10,
        codigo_regional: 3,
        codigo_situacao: '2',
        codigo_conta: 27,
        mes_referente: '11/2026',
        link_boleto: true,
        codigo_tipo_boleto: 2,
        array_parcela: [{ valor: '89,50', vencimento: '01/12/2026' }],
        referencia: [
          {
            modulo: 'veiculo',
            codigo_modulo: '555',
            descricao: 'Boleto reativação app',
            valor: '89,50',
          },
        ],
      });
    });

    it('com a revistoria conhecida, a descrição leva REV-<id>', () => {
      const corpo = montarCadastroDoBoleto({ ...base, reinspectionId: 42 });
      expect(corpo.referencia[0].descricao).toBe(
        'Boleto reativação app REV-42',
      );
      expect(descricaoDoBoleto()).toBe('Boleto reativação app');
    });
  });

  describe('parâmetros que entram em chamada ao SGA', () => {
    it.each(['9BWZZZ377VT004251', 'abc123', ' 9BWZZZ377VT004251 '])(
      'chassi válido: %s',
      (chassi) => {
        expect(ehChassiValido(chassi)).toBe(true);
      },
    );

    it.each([
      '',
      'ABC12',
      'A'.repeat(21),
      '9BW/../associado',
      '9BWZZZ377?x=1',
      '9BW ZZZ377VT0042',
      '9BWZZZ-377VT0042',
      null,
      undefined,
      123456,
    ])('chassi inválido: %s', (chassi) => {
      expect(ehChassiValido(chassi)).toBe(false);
    });

    it.each([987, '987', '000123'])('código válido: %s', (codigo) => {
      expect(ehCodigoSgaValido(codigo)).toBe(true);
    });

    it.each([0, -1, 1.5, NaN, '', '12a', '1/2', ' 12', null, undefined, {}])(
      'código inválido: %s',
      (codigo) => {
        expect(ehCodigoSgaValido(codigo)).toBe(false);
      },
    );
  });

  describe('veículos do SGA', () => {
    it('INATIVO em `descricao_situacao` ou em `situacao`, sem distinguir caixa', () => {
      expect(veiculoInativoNoSga({ descricao_situacao: 'Inativo ' })).toBe(
        true,
      );
      expect(veiculoInativoNoSga({ situacao: 'INATIVO' })).toBe(true);
      expect(veiculoInativoNoSga({ situacao: 'ATIVO' })).toBe(false);
      expect(veiculoInativoNoSga(null)).toBe(false);
    });

    it('remove os inativos sem alterar o corpo original', () => {
      const corpo = {
        nome: 'Fulano',
        veiculos: [{ chassi: 'A', situacao: 'INATIVO' }, { chassi: 'B' }],
      };
      expect(removerVeiculosInativos(corpo)).toEqual({
        nome: 'Fulano',
        veiculos: [{ chassi: 'B' }],
      });
      expect(corpo.veiculos).toHaveLength(2);
      expect(removerVeiculosInativos('texto')).toBe('texto');
    });

    it('2xx sem a lista de veículos não é "associado sem veículos"', () => {
      expect(listaDeVeiculosDoSga({ veiculos: [] })).toEqual([]);
      expect(listaDeVeiculosDoSga({ mensagem: 'erro' })).toBeNull();
      expect(listaDeVeiculosDoSga('<html>')).toBeNull();
      expect(listaDeVeiculosDoSga(null)).toBeNull();
    });
  });
});
