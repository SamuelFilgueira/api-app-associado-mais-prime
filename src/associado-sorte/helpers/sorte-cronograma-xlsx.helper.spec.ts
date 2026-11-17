import * as ExcelJS from 'exceljs';
import { lerCronogramaXlsx } from 'src/associado-sorte/helpers/sorte-cronograma-xlsx.helper';

/** Monta uma planilha no layout oficial do marketing (abas Cronograma e Resumo). */
async function planilha(opcoes: {
  linhas: [Date | string, Date | string | number, string][];
  resumo?: [string, string, number, number, number][];
}): Promise<Buffer> {
  const livro = new ExcelJS.Workbook();
  const crono = livro.addWorksheet('Cronograma');
  crono.addRow(['Associado da Sorte · Cronograma de prêmios do vale-brinde']);
  crono.addRow(['Período: 14/12/2026 a 13/12/2027 · Um prêmio por dia']);
  crono.addRow(['Dia', 'Horário', 'Prêmio']);
  for (const l of opcoes.linhas) crono.addRow(l);
  if (opcoes.resumo) {
    const resumo = livro.addWorksheet('Resumo');
    resumo.addRow(['Resumo dos prêmios']);
    resumo.addRow([
      'Prêmio',
      'Descrição',
      'Valor unitário (R$)',
      'Quantidade',
      'Valor total (R$)',
    ]);
    for (const r of opcoes.resumo) resumo.addRow(r);
    resumo.addRow(['Total', null, null, 0, 0]);
    resumo.addRow(['Observações']);
    resumo.addRow(['• Horários gerados aleatoriamente']);
  }
  return Buffer.from(await livro.xlsx.writeBuffer());
}

/** Data/hora "de parede" do Excel (o ExcelJS grava e lê em UTC). */
const dia = (a: number, m: number, d: number) =>
  new Date(Date.UTC(a, m - 1, d));
const hora = (h: number, m: number, s: number) =>
  new Date(Date.UTC(1899, 11, 30, h, m, s));

describe('lerCronogramaXlsx (planilha oficial .xlsx)', () => {
  it('lê Dia/Horário do Excel com segundos e usa o valor do Resumo', async () => {
    const r = await lerCronogramaXlsx(
      await planilha({
        linhas: [
          [dia(2026, 12, 14), hora(9, 40, 31), 'Voucher R$120'],
          [dia(2026, 12, 30), hora(19, 10, 29), 'Voucher R$200'],
          ['15/12/2026', '13:32:48', 'Voucher R$120'],
        ],
        resumo: [
          ['Voucher R$120', 'Libera R$ 120,00', 120, 2, 240],
          ['Voucher R$200', 'Libera R$ 200,00', 200, 1, 200],
        ],
      }),
    );
    expect(r.erros).toEqual([]);
    expect(r.aba).toBe('Cronograma');
    expect(r.titulo).toHaveLength(2);
    expect(r.linhas).toEqual([
      {
        linha: 4,
        liberaEm: new Date('2026-12-14T12:40:31.000Z'),
        creditos: 120,
        descricao: 'Voucher R$120',
      },
      {
        linha: 5,
        liberaEm: new Date('2026-12-30T22:10:29.000Z'),
        creditos: 200,
        descricao: 'Voucher R$200',
      },
      {
        linha: 6,
        liberaEm: new Date('2026-12-15T16:32:48.000Z'),
        creditos: 120,
        descricao: 'Voucher R$120',
      },
    ]);
    expect(r.avisos).toEqual([]);
    expect(r.resumo.map((i) => i.quantidadeNoCronograma)).toEqual([2, 1]);
  });

  it('avisa quando o Resumo diverge do cronograma (sem bloquear)', async () => {
    const r = await lerCronogramaXlsx(
      await planilha({
        linhas: [[dia(2026, 12, 14), hora(9, 0, 0), 'Voucher R$120']],
        resumo: [['Voucher R$120', 'x', 120, 2, 240]],
      }),
    );
    expect(r.linhas).toHaveLength(1);
    expect(r.erros).toEqual([]);
    expect(r.avisos).toEqual([
      '"Voucher R$120": o Resumo declara 2 e o cronograma tem 1',
      '"Voucher R$120": o Resumo declara R$ 240 e o cronograma soma 120 créditos',
    ]);
  });

  it('sem aba Resumo, os créditos saem do rótulo do prêmio', async () => {
    const r = await lerCronogramaXlsx(
      await planilha({
        linhas: [[dia(2026, 12, 14), hora(15, 0, 0), 'Voucher R$150']],
      }),
    );
    expect(r.linhas[0].creditos).toBe(150);
    expect(r.resumo).toEqual([]);
  });

  it('aponta erro por linha com o número da linha do Excel', async () => {
    const r = await lerCronogramaXlsx(
      await planilha({
        linhas: [
          [dia(2026, 12, 14), hora(9, 0, 0), 'Voucher R$120'],
          [dia(2026, 12, 14), hora(9, 0, 0), 'Voucher R$120'],
          [dia(2028, 1, 1), hora(9, 0, 0), 'Voucher'],
        ],
      }),
      {
        periodo: {
          inicio: new Date('2026-12-14T03:00:00.000Z'),
          fim: new Date('2027-12-14T02:59:59.000Z'),
        },
      },
    );
    expect(r.linhas.map((l) => l.linha)).toEqual([4]);
    expect(r.erros.map((e) => e.linha)).toEqual([5, 6]);
    expect(r.erros[0].mensagem).toContain('duplicada');
    expect(r.erros[1].mensagem).toContain('créditos inválidos');
    expect(r.erros[1].mensagem).toContain('fora do período');
  });

  it('recusa arquivo que não é .xlsx e planilha sem cabeçalho', async () => {
    const lixo = await lerCronogramaXlsx(Buffer.from('não sou xlsx'));
    expect(lixo.erros[0].mensagem).toContain('inválido');

    const livro = new ExcelJS.Workbook();
    livro.addWorksheet('Plan1').addRow(['a', 'b']);
    const semCabecalho = await lerCronogramaXlsx(
      Buffer.from(await livro.xlsx.writeBuffer()),
    );
    expect(semCabecalho.erros[0].mensagem).toContain('Cabeçalho');
  });
});
