import { readFileSync } from 'fs';
import { join } from 'path';
import {
  contemReferencia,
  localizarPorNossoNumero,
  referenciaDaRevistoria,
  selecionarBoletoParaAdocao,
} from 'src/sga/domain/boleto-adocao';

const fixture = (nome: string): { boletos: Array<Record<string, unknown>> } =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../test/fixtures', nome), 'utf8'),
  );

const HOJE = new Date(2026, 2, 9); // 09/03/2026, meia-noite local
const filtro = (extra: Record<string, unknown> = {}) => ({
  codigoVeiculo: '777',
  codigoTipoBoleto: 2,
  hoje: HOJE,
  ...extra,
});

/** Boleto de reativação em aberto do veículo 777, vencendo amanhã. */
const reativacao = (extra: Record<string, unknown> = {}) => ({
  nosso_numero: 3,
  codigo_situacao_boleto: '2',
  codigo_tipo_boleto: '2',
  data_vencimento_original: '10/03/2026',
  link_boleto: 'https://sga/boleto/3',
  linha_digitavel: '0001',
  codigo_veiculo: 777,
  ...extra,
});

describe('boleto-adocao', () => {
  it('referência da revistoria: REV-<id>', () => {
    expect(referenciaDaRevistoria(42)).toBe('REV-42');
  });

  describe('critérios de tipo e situação (os de sempre)', () => {
    it('adota o boleto de reativação em aberto com vencimento de hoje em diante', () => {
      expect(selecionarBoletoParaAdocao([reativacao()], filtro())).toEqual({
        nossoNumero: '3',
        linhaDigitavel: '0001',
        linkBoleto: 'https://sga/boleto/3',
        criterio: 'TIPO_E_SITUACAO',
      });
    });

    it.each([
      ['mensalidade (outro tipo)', { codigo_tipo_boleto: 1 }],
      ['tipo não informado', { codigo_tipo_boleto: null }],
      ['já pago', { codigo_situacao_boleto: 1 }],
      ['cancelado', { codigo_situacao_boleto: '3' }],
      ['situação não informada', { codigo_situacao_boleto: undefined }],
      ['vencido ontem', { data_vencimento_original: '08/03/2026' }],
      ['sem vencimento', { data_vencimento_original: undefined }],
      ['de outro veículo', { codigo_veiculo: 778 }],
      ['sem nosso_numero', { nosso_numero: null }],
    ])('nunca adota: %s', (_caso, extra) => {
      expect(
        selecionarBoletoParaAdocao([reativacao(extra)], filtro()),
      ).toBeNull();
    });

    it('veículo identificado em `veiculos[]`, ou não identificado, vale a consulta', () => {
      expect(
        selecionarBoletoParaAdocao(
          [
            reativacao({
              codigo_veiculo: undefined,
              veiculos: [{ codigo_veiculo: '777' }],
            }),
          ],
          filtro(),
        )?.nossoNumero,
      ).toBe('3');
      expect(
        selecionarBoletoParaAdocao(
          [reativacao({ codigo_veiculo: undefined })],
          filtro(),
        )?.nossoNumero,
      ).toBe('3');
      expect(
        selecionarBoletoParaAdocao(
          [
            reativacao({
              codigo_veiculo: undefined,
              veiculos: [{ codigo_veiculo: '1' }],
            }),
          ],
          filtro(),
        ),
      ).toBeNull();
    });

    it('mais de um candidato: o de vencimento mais próximo', () => {
      const escolhido = selecionarBoletoParaAdocao(
        [
          reativacao({
            nosso_numero: 9,
            data_vencimento_original: '20/03/2026',
          }),
          reativacao({
            nosso_numero: 8,
            data_vencimento_original: '10/03/2026',
          }),
        ],
        filtro(),
      );
      expect(escolhido?.nossoNumero).toBe('8');
    });

    it('corpo que não é lista: nada a adotar', () => {
      expect(selecionarBoletoParaAdocao({ boletos: [] }, filtro())).toBeNull();
      expect(selecionarBoletoParaAdocao(null, filtro())).toBeNull();
    });
  });

  describe('fixtures do SGA', () => {
    it('boleto de MENSALIDADE em aberto do veículo nunca é adotado', () => {
      const { boletos } = fixture('sga-boleto-kaio.mock.json');
      // tipo 1 (MENSALIDADE), situação 2 (ABERTO), veículo 90501
      expect(
        selecionarBoletoParaAdocao(
          boletos,
          filtro({ codigoVeiculo: '90501', hoje: new Date(2026, 0, 1) }),
        ),
      ).toBeNull();
    });

    it('lista do período: itens sem tipo de boleto não são adotados; o pago também não', () => {
      const { boletos } = fixture('sga-boletos-periodo.mock.json');
      for (const codigoVeiculo of ['501', '502', '503', '504']) {
        expect(
          selecionarBoletoParaAdocao(
            boletos,
            filtro({ codigoVeiculo, hoje: new Date(2026, 0, 1) }),
          ),
        ).toBeNull();
      }
    });

    it('os itens das fixtures não trazem nenhum campo de texto com a referência', () => {
      // Nada nas listagens guardadas prova que o SGA devolve a descrição do
      // boleto: a busca por referência só encontra algo se o SGA real a
      // devolver; senão valem os critérios de sempre.
      const itens = [
        ...fixture('sga-boleto-kaio.mock.json').boletos,
        ...fixture('sga-boletos-periodo.mock.json').boletos,
      ];
      expect(itens.some((item) => contemReferencia(item, 'REV-1'))).toBe(false);
    });
  });

  describe('referência da revistoria primeiro', () => {
    it('com dois candidatos, prefere o que carrega a referência — mesmo vencendo depois', () => {
      const escolhido = selecionarBoletoParaAdocao(
        [
          reativacao({
            nosso_numero: 8,
            data_vencimento_original: '10/03/2026',
          }),
          reativacao({
            nosso_numero: 9,
            data_vencimento_original: '20/03/2026',
            referencia: [{ descricao: 'Boleto reativação app REV-10' }],
          }),
        ],
        filtro({ referencia: 'REV-10' }),
      );
      expect(escolhido).toMatchObject({
        nossoNumero: '9',
        criterio: 'REFERENCIA',
      });
    });

    it('reconhece o próprio boleto mesmo sem tipo e com vencimento passado', () => {
      const escolhido = selecionarBoletoParaAdocao(
        [
          reativacao({
            codigo_tipo_boleto: null,
            data_vencimento_original: '01/03/2026',
            descricao: 'Boleto reativação app REV-10',
          }),
        ],
        filtro({ referencia: 'REV-10' }),
      );
      expect(escolhido?.criterio).toBe('REFERENCIA');
    });

    it('boleto próprio já PAGO é adotado (a verificação de pagamento conclui a reativação)', () => {
      const escolhido = selecionarBoletoParaAdocao(
        [reativacao({ codigo_situacao_boleto: '1', observacao: 'REV-10' })],
        filtro({ referencia: 'REV-10' }),
      );
      expect(escolhido?.nossoNumero).toBe('3');
    });

    it.each(['3', '999'])(
      'boleto próprio cancelado/excluído (%s) não é adotado',
      (situacao) => {
        expect(
          selecionarBoletoParaAdocao(
            [
              reativacao({
                codigo_situacao_boleto: situacao,
                observacao: 'REV-10',
              }),
            ],
            filtro({ referencia: 'REV-10' }),
          ),
        ).toBeNull();
      },
    );

    it('a referência de OUTRA revistoria não casa: REV-1 não é REV-10 nem REV-100', () => {
      expect(contemReferencia({ d: 'app REV-10' }, 'REV-1')).toBe(false);
      expect(contemReferencia({ d: 'app REV-100' }, 'REV-10')).toBe(false);
      expect(contemReferencia({ d: 'XREV-10' }, 'REV-10')).toBe(false);
      expect(contemReferencia({ d: 'app REV-10.' }, 'REV-10')).toBe(true);
      expect(contemReferencia({ a: [{ b: 'REV-10' }] }, 'REV-10')).toBe(true);
      expect(contemReferencia({ nosso_numero: 10 }, 'REV-10')).toBe(false);
    });

    it('referência de outro veículo não vale', () => {
      expect(
        selecionarBoletoParaAdocao(
          [reativacao({ codigo_veiculo: 1, descricao: 'REV-10' })],
          filtro({ referencia: 'REV-10' }),
        ),
      ).toBeNull();
    });

    it('sem nenhum item com a referência, valem os critérios de sempre', () => {
      expect(
        selecionarBoletoParaAdocao(
          [reativacao()],
          filtro({ referencia: 'REV-10' }),
        ),
      ).toMatchObject({ nossoNumero: '3', criterio: 'TIPO_E_SITUACAO' });
    });
  });

  describe('localizarPorNossoNumero (retomada)', () => {
    it('só o item com o número exato', () => {
      const itens = [
        reativacao({ nosso_numero: 30 }),
        reativacao({ nosso_numero: 3, link_boleto: 'https://sga/boleto/3' }),
      ];
      expect(localizarPorNossoNumero(itens, '3')).toEqual({
        nossoNumero: '3',
        linhaDigitavel: '0001',
        linkBoleto: 'https://sga/boleto/3',
      });
      expect(localizarPorNossoNumero(itens, '300')).toBeNull();
      expect(localizarPorNossoNumero(null, '3')).toBeNull();
    });
  });
});
