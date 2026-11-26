import { addDays, formatDateBR } from 'src/shared/date.util';
import {
  janelaDaEtapa,
  janelaDeConsulta,
  simularJanelas,
  vencimentoNaJanela,
} from 'src/boleto-notificacao/domain/regua-janelas';
import {
  RegrasDeJanela,
  TIPOS_MENSAGEM,
  TipoMensagem,
} from 'src/boleto-notificacao/domain/regua-tipos';

/** Regras padrão da régua (documento do gestor, v. 10/09/2026). */
const PADRAO: RegrasDeJanela = {
  offsets: { DM5: 5, D0: 0, D1: 1, D5: 5, D6: 6, D20: 20 },
  alcanceD20: 40,
};

const janelas = (referencia: Date, regras = PADRAO) =>
  Object.fromEntries(
    TIPOS_MENSAGEM.map((tipo) => [
      tipo,
      janelaDaEtapa(referencia, tipo, regras).descricao,
    ]),
  ) as Record<TipoMensagem, string>;

describe('Janelas da régua (regra pura, data injetada)', () => {
  it('dia comum: cada etapa cobre a sua faixa de atraso', () => {
    expect(janelas(new Date(2026, 8, 10))).toEqual({
      DM5: '11/09/2026 a 15/09/2026',
      D0: '10/09/2026',
      D1: '06/09/2026 a 09/09/2026',
      D5: '05/09/2026',
      D6: '22/08/2026 a 04/09/2026',
      D20: '12/07/2026 a 21/08/2026',
    });
  });

  it('fim de mês (31/01): a D-5 entra em fevereiro e as de atraso ficam em janeiro/dezembro', () => {
    expect(janelas(new Date(2027, 0, 31))).toEqual({
      DM5: '01/02/2027 a 05/02/2027',
      D0: '31/01/2027',
      D1: '27/01/2027 a 30/01/2027',
      D5: '26/01/2027',
      D6: '12/01/2027 a 25/01/2027',
      D20: '02/12/2026 a 11/01/2027',
    });
  });

  it('fevereiro de ano comum (28/02/2027): a D-5 começa em 01/03', () => {
    const j = janelas(new Date(2027, 1, 28));
    expect(j.DM5).toBe('01/03/2027 a 05/03/2027');
    expect(j.D1).toBe('24/02/2027 a 27/02/2027');
  });

  it('ano bissexto: 29/02/2028 existe nas janelas em volta dele', () => {
    expect(janelas(new Date(2028, 1, 27)).DM5).toBe('28/02/2028 a 03/03/2028');
    expect(janelas(new Date(2028, 2, 1)).D1).toBe('26/02/2028 a 29/02/2028');
    expect(janelas(new Date(2028, 2, 5)).D5).toBe('29/02/2028');
  });

  it('virada de ano (01/01/2027): as etapas de atraso olham para dezembro do ano anterior', () => {
    expect(janelas(new Date(2027, 0, 1))).toEqual({
      DM5: '02/01/2027 a 06/01/2027',
      D0: '01/01/2027',
      D1: '28/12/2026 a 31/12/2026',
      D5: '27/12/2026',
      D6: '13/12/2026 a 26/12/2026',
      D20: '02/11/2026 a 12/12/2026',
    });
  });

  it('véspera da virada (29/12/2026): a D-5 atravessa para janeiro', () => {
    expect(janelas(new Date(2026, 11, 29)).DM5).toBe('30/12/2026 a 03/01/2027');
  });

  it('só a parte de data da referência conta (hora do dia é ignorada)', () => {
    const manha = janelaDaEtapa(new Date(2026, 8, 10, 0, 0, 1), 'D1', PADRAO);
    const noite = janelaDaEtapa(
      new Date(2026, 8, 10, 23, 59, 59),
      'D1',
      PADRAO,
    );
    expect(noite).toEqual(manha);
    expect(manha.inicio.getHours()).toBe(0);
    expect(manha.fim).toEqual(new Date(2026, 8, 9));
  });

  it('as janelas não se sobrepõem e cobrem toda a consulta: cada vencimento cai em exatamente UMA etapa', () => {
    // Inclui fim de mês, virada de ano e 29/02.
    const referencias = [
      new Date(2026, 8, 10),
      new Date(2026, 11, 31),
      new Date(2027, 0, 1),
      new Date(2027, 1, 28),
      new Date(2028, 1, 29),
      new Date(2028, 2, 1),
    ];
    for (const referencia of referencias) {
      const consulta = janelaDeConsulta(referencia, PADRAO);
      for (
        let vencimento = consulta.inicio;
        vencimento <= consulta.fim;
        vencimento = addDays(vencimento, 1)
      ) {
        const etapas = TIPOS_MENSAGEM.filter((tipo) =>
          vencimentoNaJanela(
            vencimento,
            janelaDaEtapa(referencia, tipo, PADRAO),
          ),
        );
        expect([
          formatDateBR(referencia),
          formatDateBR(vencimento),
          etapas.length,
        ]).toEqual([formatDateBR(referencia), formatDateBR(vencimento), 1]);
      }
      // Um dia além de cada ponta já está fora de todas as etapas.
      for (const fora of [
        addDays(consulta.inicio, -1),
        addDays(consulta.fim, 1),
      ]) {
        expect(
          TIPOS_MENSAGEM.some((tipo) =>
            vencimentoNaJanela(fora, janelaDaEtapa(referencia, tipo, PADRAO)),
          ),
        ).toBe(false);
      }
    }
  });

  it('um boleto que vence em 31/12 percorre as seis etapas nos dias certos, atravessando o ano', () => {
    const vencimento = new Date(2026, 11, 31);
    const diasPorEtapa: Record<string, string[]> = {};
    for (
      let dia = new Date(2026, 11, 20);
      dia <= new Date(2027, 2, 15);
      dia = addDays(dia, 1)
    ) {
      for (const tipo of TIPOS_MENSAGEM) {
        if (vencimentoNaJanela(vencimento, janelaDaEtapa(dia, tipo, PADRAO))) {
          (diasPorEtapa[tipo] ??= []).push(formatDateBR(dia));
        }
      }
    }
    // Primeiro dia de cada faixa = dia em que o push sai (o resto é catch-up).
    expect(
      Object.fromEntries(
        Object.entries(diasPorEtapa).map(([tipo, dias]) => [
          tipo,
          [dias[0], dias[dias.length - 1], dias.length],
        ]),
      ),
    ).toEqual({
      DM5: ['26/12/2026', '30/12/2026', 5],
      D0: ['31/12/2026', '31/12/2026', 1],
      D1: ['01/01/2027', '04/01/2027', 4],
      D5: ['05/01/2027', '05/01/2027', 1],
      D6: ['06/01/2027', '19/01/2027', 14],
      D20: ['20/01/2027', '01/03/2027', 41],
    });
  });

  it('janela da consulta única: do alcance do D+20 até o fim da D-5', () => {
    expect(janelaDeConsulta(new Date(2027, 0, 1), PADRAO)).toEqual({
      inicio: new Date(2026, 10, 2), // 01/01 − 60
      fim: new Date(2027, 0, 6), // 01/01 + 5
    });
  });

  it('offsets e alcance configurados deslocam as faixas', () => {
    const regras: RegrasDeJanela = {
      offsets: { DM5: 3, D0: 0, D1: 2, D5: 7, D6: 8, D20: 30 },
      alcanceD20: 0,
    };
    expect(janelas(new Date(2026, 8, 10), regras)).toEqual({
      DM5: '11/09/2026 a 13/09/2026',
      D0: '10/09/2026',
      D1: '04/09/2026 a 08/09/2026', // atraso 2..6
      D5: '03/09/2026', // atraso 7
      D6: '12/08/2026 a 02/09/2026', // atraso 8..29
      D20: '11/08/2026', // atraso 30, sem alcance
    });
  });

  it('vencimentoNaJanela: pontas incluídas; sem data fica fora', () => {
    const janela = janelaDaEtapa(new Date(2026, 8, 10), 'D1', PADRAO);
    expect(vencimentoNaJanela(new Date(2026, 8, 6), janela)).toBe(true);
    expect(vencimentoNaJanela(new Date(2026, 8, 9), janela)).toBe(true);
    expect(vencimentoNaJanela(new Date(2026, 8, 5), janela)).toBe(false);
    expect(vencimentoNaJanela(new Date(2026, 8, 10), janela)).toBe(false);
    expect(vencimentoNaJanela(null, janela)).toBe(false);
  });

  it('simularJanelas: uma linha por etapa, na ordem da régua, sempre com gatilho', () => {
    const simulacao = simularJanelas(new Date(2026, 11, 31), PADRAO);
    expect(simulacao.map((s) => s.tipo)).toEqual(TIPOS_MENSAGEM);
    expect(simulacao.every((s) => s.gatilho)).toBe(true);
    expect(simulacao[0]).toEqual({
      tipo: 'DM5',
      offset: 5,
      dataAlvo: '01/01/2027 a 05/01/2027',
      gatilho: true,
    });
  });
});
