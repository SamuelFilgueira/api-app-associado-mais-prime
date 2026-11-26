import { readFileSync } from 'fs';
import { join } from 'path';
import {
  boletosCadastrados,
  boletosDaConsulta,
  lerAssociadoParaBoleto,
  lerBoletoCadastrado,
  lerProdutosDoVeiculo,
  lerSituacaoDaConsulta,
  lerSituacaoDaListagem,
  nossoNumeroParaSga,
} from 'src/sga/domain/boleto-sga.parser';

const fixture = (nome: string): { boletos: Array<Record<string, unknown>> } =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../test/fixtures', nome), 'utf8'),
  );

/** Respostas do SGA guardadas em `test/fixtures`. */
const KAIO = fixture('sga-boleto-kaio.mock.json');
const PERIODO = fixture('sga-boletos-periodo.mock.json');

describe('boleto-sga.parser', () => {
  describe('boleto/cadastrar — formatos conhecidos da resposta', () => {
    const boleto = {
      nosso_numero: 123,
      linha_digitavel: '0001',
      link_boleto: 'https://sga/boleto/123',
    };
    const esperado = {
      nossoNumero: '123',
      linhaDigitavel: '0001',
      linkBoleto: 'https://sga/boleto/123',
      encontrado: true,
    };

    it.each([
      ['array direto', [boleto]],
      ['`dados_boleto_inserido`', { dados_boleto_inserido: [boleto] }],
      ['chaves numéricas + mensagem', { '0': boleto, mensagem: 'ok' }],
    ])('%s', (_formato, corpo) => {
      expect(lerBoletoCadastrado(corpo)).toEqual(esperado);
    });

    it.each([
      ['corpo vazio', null],
      ['só mensagem', { mensagem: 'Boleto cadastrado' }],
      ['HTML de proxy', '<html>502</html>'],
      ['lista vazia', []],
    ])(
      '2xx sem os dados do boleto (%s): não inventa boleto',
      (_caso, corpo) => {
        expect(lerBoletoCadastrado(corpo)).toEqual({
          nossoNumero: null,
          linhaDigitavel: null,
          linkBoleto: null,
          encontrado: false,
        });
        expect(boletosCadastrados(corpo)).toEqual([]);
      },
    );

    it('campos de tipo inesperado saem nulos; nosso_numero vira texto', () => {
      expect(
        lerBoletoCadastrado([
          { nosso_numero: '000987', linha_digitavel: 1, link_boleto: null },
        ]),
      ).toEqual({
        nossoNumero: '000987',
        linhaDigitavel: null,
        linkBoleto: null,
        encontrado: true,
      });
    });
  });

  describe('processa-pdf/boleto — situação do boleto', () => {
    it('acha o item pelo nosso_numero entre vários (fixture do período)', () => {
      // 900004 é o único BAIXADO da lista; os demais estão em aberto.
      expect(
        lerSituacaoDaConsulta(PERIODO.boletos, 900004).codigoSituacao,
      ).toBe('1');
      expect(
        lerSituacaoDaConsulta(PERIODO.boletos, '900002').codigoSituacao,
      ).toBe('2');
    });

    it('situação numérica ou em texto vira sempre texto', () => {
      expect(
        lerSituacaoDaConsulta(
          [{ nosso_numero: 1, codigo_situacao_boleto: 4 }],
          1,
        ).codigoSituacao,
      ).toBe('4');
      expect(lerSituacaoDaConsulta(KAIO.boletos, 9990001).codigoSituacao).toBe(
        '2',
      );
    });

    it('nenhum item com o nosso_numero: vale o primeiro (a consulta já foi por nosso_numero)', () => {
      const lida = lerSituacaoDaConsulta(
        [{ codigo_situacao_boleto: '1', link_boleto: 'x' }],
        555,
      );
      expect(lida.codigoSituacao).toBe('1');
      expect(lida.boleto).toMatchObject({ link_boleto: 'x' });
    });

    it('objeto solto e corpo em texto JSON também são lidos', () => {
      expect(
        lerSituacaoDaConsulta({ nosso_numero: 7, codigo_situacao_boleto: 3 }, 7)
          .codigoSituacao,
      ).toBe('3');
      expect(
        lerSituacaoDaConsulta(
          JSON.stringify([{ nosso_numero: 7, codigo_situacao_boleto: 999 }]),
          7,
        ).codigoSituacao,
      ).toBe('999');
    });

    it.each([
      ['lista vazia', []],
      ['corpo vazio', null],
      ['texto que não é JSON', 'N/A'],
      ['item sem situação', [{ nosso_numero: 7 }]],
      ['situação nula', [{ nosso_numero: 7, codigo_situacao_boleto: null }]],
    ])('sem situação (%s): devolve undefined', (_caso, corpo) => {
      expect(lerSituacaoDaConsulta(corpo, 7).codigoSituacao).toBeUndefined();
    });

    it('envelope paginado do período NÃO é lido como boleto: sem situação, cai na listagem por veículo', () => {
      // `{ boletos: [...] }` não é formato de `processa-pdf`: o envelope vira
      // um "boleto" sem situação e nenhuma situação é atribuída por engano.
      expect(boletosDaConsulta(PERIODO)).toHaveLength(1);
      expect(
        lerSituacaoDaConsulta(PERIODO, 900004).codigoSituacao,
      ).toBeUndefined();
    });
  });

  describe('listar/boleto-associado-veiculo — situação pelo nosso_numero exato', () => {
    it('acha o boleto na lista do veículo (fixtures)', () => {
      expect(lerSituacaoDaListagem(PERIODO.boletos, 900004)).toMatchObject({
        codigoSituacao: '1',
        encontrados: 4,
      });
      expect(lerSituacaoDaListagem(KAIO.boletos, '9990001')).toMatchObject({
        codigoSituacao: '2',
        encontrados: 1,
      });
    });

    it('nosso_numero que não está na lista: sem situação — nunca usa o boleto de outro', () => {
      expect(lerSituacaoDaListagem(PERIODO.boletos, 123)).toEqual({
        codigoSituacao: undefined,
        boleto: undefined,
        encontrados: 4,
      });
    });

    it('corpo que não é lista: sem situação', () => {
      expect(lerSituacaoDaListagem(PERIODO, 900004).codigoSituacao).toBe(
        undefined,
      );
      expect(lerSituacaoDaListagem(null, 1).encontrados).toBe(0);
    });
  });

  describe('associado e produtos usados no boleto', () => {
    it('lê o associado de objeto ou de lista', () => {
      const corpo = {
        codigo_associado: '10',
        codigo_regional: 3,
        nome: 'Fulano',
        telefone_celular: '31999999999',
      };
      const esperado = {
        codigoAssociado: 10,
        codigoRegional: 3,
        nome: 'Fulano',
        telefoneCelular: '31999999999',
      };
      expect(lerAssociadoParaBoleto(corpo)).toEqual(esperado);
      expect(lerAssociadoParaBoleto([corpo])).toEqual(esperado);
    });

    it('sem codigo_associado não há associado', () => {
      expect(lerAssociadoParaBoleto({ nome: 'Fulano' })).toBeNull();
      expect(lerAssociadoParaBoleto([])).toBeNull();
      expect(lerAssociadoParaBoleto('<html>')).toBeNull();
    });

    it('produtos: valor, taxa (pode ser negativa) e código do veículo', () => {
      expect(
        lerProdutosDoVeiculo({
          valor_total_produtos_ativo_reais: 100,
          taxa_administrativa: '-10.50',
          codigo_veiculo: 555,
        }),
      ).toEqual({
        valorTotalProdutosAtivo: 100,
        taxaAdministrativa: '-10.50',
        codigoVeiculo: '555',
      });
      expect(lerProdutosDoVeiculo([])).toEqual({
        valorTotalProdutosAtivo: 0,
        taxaAdministrativa: '0',
        codigoVeiculo: undefined,
      });
    });
  });

  it('nosso_numero segue para o SGA como número; valor grande demais segue como texto', () => {
    expect(nossoNumeroParaSga('123')).toBe(123);
    expect(nossoNumeroParaSga('12345678901234567890')).toBe(
      '12345678901234567890',
    );
  });
});
