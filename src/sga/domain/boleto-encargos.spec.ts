import { montarCadastroDoBoleto } from 'src/sga/domain/boleto-cadastro';
import {
  calcularEncargos,
  dataIso,
  diasDeAtraso,
  itensDaListagem,
  lerDataDoSga,
  montarRegistroDeEncargos,
  paraCentavos,
  referenciaGravada,
  selecionarUltimoBoletoEmAberto,
} from 'src/sga/domain/boleto-encargos';

/** Regra da Hertz: multa de 2% (uma vez) + mora de 0,5% ao dia. */
const HERTZ = { multaPercentual: 2, moraDiariaPercentual: 0.5 };
const dia = (ano: number, mes: number, d: number) => new Date(ano, mes - 1, d);

describe('encargos por atraso do boleto de reativação', () => {
  describe('calcularEncargos', () => {
    it('sem atraso: nem multa nem mora — o total é o valor base', () => {
      expect(
        calcularEncargos({ baseCentavos: 10_000, dias: 0, regra: HERTZ }),
      ).toEqual({
        baseCentavos: 10_000,
        multaCentavos: 0,
        moraCentavos: 0,
        totalCentavos: 10_000,
        diasDeAtraso: 0,
      });
    });

    it('1 dia de atraso: multa de 2% + mora de 0,5% sobre o valor base', () => {
      // R$ 100,00 → multa 2,00 + mora 0,50 = 102,50
      expect(
        calcularEncargos({ baseCentavos: 10_000, dias: 1, regra: HERTZ }),
      ).toMatchObject({
        multaCentavos: 200,
        moraCentavos: 50,
        totalCentavos: 10_250,
      });
    });

    it('a multa NUNCA é por dia: com 30 dias ela continua 2% do valor base', () => {
      // R$ 100,00, 30 dias → multa 2,00 + mora 15,00 (0,5% × 30) = 117,00
      const r = calcularEncargos({
        baseCentavos: 10_000,
        dias: 30,
        regra: HERTZ,
      });

      expect(r.multaCentavos).toBe(200);
      expect(r.moraCentavos).toBe(1_500);
      expect(r.totalCentavos).toBe(11_700);
    });

    it('a mora é sempre sobre o valor base (juros simples), não sobre base + multa', () => {
      // R$ 250,00, 10 dias → mora 12,50 (250 × 0,5% × 10), e não 12,75.
      const r = calcularEncargos({
        baseCentavos: 25_000,
        dias: 10,
        regra: HERTZ,
      });

      expect(r.moraCentavos).toBe(1_250);
      expect(r.totalCentavos).toBe(25_000 + 500 + 1_250);
    });

    it.each([
      // base, dias, multa, mora, total (centavos)
      [12_990, 7, 260, 455, 13_705], // 129,90 → 2,598≈2,60 e 4,5465≈4,55
      [18_937, 45, 379, 4_261, 23_577], // 189,37 → 3,7874≈3,79 e 42,608≈42,61
      [9_999, 3, 200, 150, 10_349], // 99,99 → 1,9998≈2,00 e 1,49985≈1,50
    ])(
      'arredonda multa e mora ao centavo: base %i, %i dias',
      (base, dias, multa, mora, total) => {
        expect(
          calcularEncargos({ baseCentavos: base, dias, regra: HERTZ }),
        ).toMatchObject({
          multaCentavos: multa,
          moraCentavos: mora,
          totalCentavos: total,
        });
      },
    );

    it('dias negativos ou fracionados não geram desconto nem fração de dia', () => {
      expect(
        calcularEncargos({ baseCentavos: 10_000, dias: -5, regra: HERTZ })
          .totalCentavos,
      ).toBe(10_000);
      expect(
        calcularEncargos({ baseCentavos: 10_000, dias: 2.9, regra: HERTZ })
          .diasDeAtraso,
      ).toBe(2);
    });

    it('paraCentavos não perde centavo por ponto flutuante', () => {
      expect(paraCentavos(129.9)).toBe(12_990);
      expect(paraCentavos(0.1 + 0.2)).toBe(30);
      expect(paraCentavos(1005.555)).toBe(100_556);
    });
  });

  describe('diasDeAtraso', () => {
    it('conta dias corridos entre o vencimento e hoje', () => {
      expect(diasDeAtraso(dia(2026, 11, 10), dia(2026, 11, 26))).toBe(16);
      expect(diasDeAtraso(dia(2026, 10, 31), dia(2026, 11, 1))).toBe(1);
      expect(diasDeAtraso(dia(2025, 12, 31), dia(2026, 1, 30))).toBe(30);
    });

    it('vencimento hoje ou no futuro: zero', () => {
      expect(diasDeAtraso(dia(2026, 11, 26), dia(2026, 11, 26))).toBe(0);
      expect(diasDeAtraso(dia(2026, 12, 5), dia(2026, 11, 26))).toBe(0);
    });

    it('a hora do dia não muda a contagem', () => {
      const hojeDeNoite = new Date(2026, 10, 26, 23, 59, 59);
      const hojeDeManha = new Date(2026, 10, 26, 0, 0, 1);

      expect(diasDeAtraso(dia(2026, 11, 25), hojeDeNoite)).toBe(1);
      expect(diasDeAtraso(dia(2026, 11, 25), hojeDeManha)).toBe(1);
    });
  });

  describe('lerDataDoSga', () => {
    it('aceita AAAA-MM-DD (listagens) e DD/MM/AAAA (filtros)', () => {
      expect(dataIso(lerDataDoSga('2026-11-10')!)).toBe('2026-11-10');
      expect(dataIso(lerDataDoSga('10/11/2026')!)).toBe('2026-11-10');
      expect(dataIso(lerDataDoSga('2026-11-10 00:00:00')!)).toBe('2026-11-10');
    });

    it('recusa o que não é data', () => {
      expect(lerDataDoSga('2026-02-31')).toBeNull();
      expect(lerDataDoSga('31/02/2026')).toBeNull();
      expect(lerDataDoSga('')).toBeNull();
      expect(lerDataDoSga(null)).toBeNull();
      expect(lerDataDoSga(20261110)).toBeNull();
    });
  });

  describe('selecionarUltimoBoletoEmAberto', () => {
    const hoje = dia(2026, 11, 26);
    const boleto = (extra: Record<string, unknown>) => ({
      nosso_numero: 100,
      codigo_situacao_boleto: '2',
      codigo_tipo_boleto: '1',
      valor_boleto: '129.90',
      data_vencimento: '2026-11-10',
      data_vencimento_original: '2026-11-10',
      veiculos: [{ codigo_veiculo: 555 }],
      ...extra,
    });
    const escolher = (itens: unknown) =>
      selecionarUltimoBoletoEmAberto(itens, { codigoVeiculo: '555', hoje });

    it('devolve o boleto em aberto de vencimento mais recente até hoje', () => {
      const r = escolher([
        boleto({ nosso_numero: 1, data_vencimento: '2026-09-10' }),
        boleto({ nosso_numero: 2, data_vencimento: '2026-11-10' }),
        boleto({ nosso_numero: 3, data_vencimento: '2026-10-10' }),
      ]);

      expect(r).toMatchObject({
        nossoNumero: '2',
        valor: '129.90',
        codigoTipoBoleto: '1',
      });
      expect(dataIso(r!.vencimento)).toBe('2026-11-10');
    });

    it('boleto que ainda vai vencer não entra (não há atraso nele, e não deve ser cancelado)', () => {
      const r = escolher([
        boleto({ nosso_numero: 1, data_vencimento: '2026-11-10' }),
        boleto({ nosso_numero: 2, data_vencimento: '2026-12-10' }),
      ]);

      expect(r?.nossoNumero).toBe('1');
    });

    it('boleto que vence hoje entra, com zero dia de atraso', () => {
      const r = escolher([
        boleto({ nosso_numero: 9, data_vencimento: '2026-11-26' }),
      ]);

      expect(r?.nossoNumero).toBe('9');
      expect(diasDeAtraso(r!.vencimento, hoje)).toBe(0);
    });

    it('só boleto em ABERTO (2): pago, cancelado e excluído ficam de fora', () => {
      expect(
        escolher([
          boleto({ nosso_numero: 1, codigo_situacao_boleto: '1' }),
          boleto({ nosso_numero: 2, codigo_situacao_boleto: 3 }),
          boleto({ nosso_numero: 3, codigo_situacao_boleto: '999' }),
          boleto({ nosso_numero: 4, codigo_situacao_boleto: undefined }),
        ]),
      ).toBeNull();
    });

    it('boleto de outro veículo do mesmo associado não serve', () => {
      expect(
        escolher([boleto({ veiculos: [{ codigo_veiculo: 777 }] })]),
      ).toBeNull();
    });

    it('vale o vencimento vigente; o original só quando o vigente não vem', () => {
      const prorrogado = escolher([
        boleto({
          data_vencimento: '2026-11-20',
          data_vencimento_original: '2026-11-10',
        }),
      ]);
      const semVigente = escolher([
        boleto({
          data_vencimento: undefined,
          data_vencimento_original: '2026-11-10',
        }),
      ]);

      expect(dataIso(prorrogado!.vencimento)).toBe('2026-11-20');
      expect(dataIso(semVigente!.vencimento)).toBe('2026-11-10');
    });

    it('empate de vencimento: fica o de maior nosso_numero', () => {
      expect(
        escolher([boleto({ nosso_numero: 10 }), boleto({ nosso_numero: 20 })])
          ?.nossoNumero,
      ).toBe('20');
    });

    it('guarda os dias vencidos informados pelo SGA, para conferência', () => {
      expect(
        escolher([boleto({ quantidade_dias_vencidos: 16 })])?.diasVencidosNoSga,
      ).toBe(16);
      expect(escolher([boleto({})])?.diasVencidosNoSga).toBeNull();
    });

    it('item sem número, sem data ou resposta que não é lista: nada', () => {
      expect(escolher([boleto({ nosso_numero: null })])).toBeNull();
      expect(
        escolher([
          boleto({
            data_vencimento: 'x',
            data_vencimento_original: undefined,
          }),
        ]),
      ).toBeNull();
      expect(escolher(null)).toBeNull();
      expect(escolher('erro')).toBeNull();
    });

    it('aceita a resposta como objeto de chaves numéricas', () => {
      expect(
        itensDaListagem({ 0: boleto({}), 1: boleto({}), mensagem: 'OK' }),
      ).toHaveLength(2);
      expect(escolher({ 0: boleto({ nosso_numero: 7 }) })?.nossoNumero).toBe(
        '7',
      );
    });
  });

  describe('registro de auditoria', () => {
    const anterior = {
      nossoNumero: '100',
      vencimento: dia(2026, 11, 10),
      valor: '129.90',
      codigoTipoBoleto: '1',
      diasVencidosNoSga: 16,
    };

    it('guarda a memória de cálculo e o boleto que serviu de base', () => {
      const calculo = calcularEncargos({
        baseCentavos: 12_990,
        dias: 16,
        regra: HERTZ,
      });

      expect(
        montarRegistroDeEncargos({
          regra: { ...HERTZ },
          calculo,
          boletoAnterior: anterior,
          vencimentoDeReferencia: anterior.vencimento,
        }),
      ).toEqual({
        regra: { multaPercentual: 2, moraDiariaPercentual: 0.5 },
        valorBase: '129.90',
        multa: '2.60',
        mora: '10.39',
        valorTotal: '142.89',
        diasDeAtraso: 16,
        vencimentoDeReferencia: '2026-11-10',
        boletoAnterior: {
          nossoNumero: '100',
          vencimento: '2026-11-10',
          valor: '129.90',
          codigoTipoBoleto: '1',
        },
        cancelamento: { situacao: 'NAO_APLICAVEL', motivo: null, em: null },
      });
    });

    it('a data de referência gravada é lida de volta (e lixo vira null)', () => {
      expect(
        dataIso(referenciaGravada({ vencimentoDeReferencia: '2026-10-05' })!),
      ).toBe('2026-10-05');
      expect(referenciaGravada({ vencimentoDeReferencia: 123 })).toBeNull();
      expect(referenciaGravada(null)).toBeNull();
      expect(referenciaGravada('texto')).toBeNull();
    });
  });

  describe('montarCadastroDoBoleto', () => {
    const base = {
      associado: { codigoAssociado: 10, codigoRegional: 3 },
      produtos: {
        valorTotalProdutosAtivo: 120,
        taxaAdministrativa: '9.90',
        codigoVeiculo: '555',
      },
      codigos: { codigoConta: 2, codigoTipoBoleto: 2 },
      agora: new Date(2026, 10, 26, 10, 0, 0),
      reinspectionId: 42,
    };

    it('sem encargos: o valor de sempre (produtos ativos + taxa administrativa)', () => {
      const corpo = montarCadastroDoBoleto(base);

      expect(corpo.array_parcela).toEqual([
        { valor: '129,90', vencimento: '27/11/2026' },
      ]);
      expect(corpo.referencia[0].valor).toBe('129,90');
    });

    it('com encargos: a parcela e a referência levam o valor total', () => {
      const corpo = montarCadastroDoBoleto({
        ...base,
        valorTotalCentavos: 14_289,
      });

      expect(corpo.array_parcela).toEqual([
        { valor: '142,89', vencimento: '27/11/2026' },
      ]);
      expect(corpo.referencia[0].valor).toBe('142,89');
    });
  });
});
