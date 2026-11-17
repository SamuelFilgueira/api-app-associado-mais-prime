import * as ExcelJS from 'exceljs';
import {
  ColunasCronograma,
  CronogramaLido,
  LinhaBrutaCronograma,
  OpcoesCronograma,
  lerCreditos,
  mapearColunas,
  normalizarCabecalho,
  validarLinhasCronograma,
} from 'src/associado-sorte/helpers/sorte-cronograma.helper';

/**
 * Leitura da planilha oficial do cronograma (.xlsx do marketing):
 *
 *  - aba **Cronograma** (ou a primeira aba): linhas de título, depois o
 *    cabeçalho `Dia | Horário | Prêmio` e um prêmio por linha. Dia e horário
 *    podem vir como data/hora do Excel ou como texto;
 *  - aba **Resumo** (opcional): `Prêmio | Descrição | Valor unitário (R$) |
 *    Quantidade | Valor total (R$)`. Quando existe, o valor unitário do
 *    prêmio define os créditos, e as quantidades/totais declarados são
 *    conferidos contra o cronograma (divergência vira aviso na prévia).
 */

export interface ItemResumoCronograma {
  premio: string;
  descricao: string | null;
  valorUnitario: number | null;
  quantidadeDeclarada: number | null;
  valorTotalDeclarado: number | null;
  quantidadeNoCronograma: number;
  valorTotalNoCronograma: number;
}

export interface CronogramaXlsxLido extends CronogramaLido {
  /** Aba de onde saíram os momentos. */
  aba: string;
  /** Linhas de título acima do cabeçalho (ex.: período e promotora). */
  titulo: string[];
  /** Conferência com a aba Resumo (vazio se a aba não existir). */
  resumo: ItemResumoCronograma[];
  /** Divergências entre Resumo e Cronograma (não bloqueiam a importação). */
  avisos: string[];
}

const LINHAS_DE_TITULO_MAX = 20;
const p2 = (n: number) => String(n).padStart(2, '0');

/** Valor "cru" da célula (resultado de fórmula, rich text, hyperlink). */
function valorDaCelula(valor: ExcelJS.CellValue): unknown {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor;
  if (typeof valor === 'object') {
    const v = valor as unknown as Record<string, unknown>;
    if ('result' in v) return v.result ?? null;
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as { text: string }[]).map((t) => t.text).join('');
    }
    if ('text' in v) return v.text;
    return null;
  }
  return valor;
}

function texto(valor: ExcelJS.CellValue): string {
  const v = valorDaCelula(valor);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v as string | number | boolean).trim();
}

/** Serial do Excel (dias desde 30/12/1899) → Date em UTC "de parede". */
function serialParaDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400) * 1000);
}

/**
 * Data da célula como DD/MM/AAAA. O ExcelJS entrega datas como `Date` em UTC
 * representando o horário "de parede" da planilha; por isso os componentes
 * UTC são os que valem.
 */
function textoData(valor: ExcelJS.CellValue): string {
  const v = valorDaCelula(valor);
  const d =
    v instanceof Date ? v : typeof v === 'number' ? serialParaDate(v) : null;
  if (!d) return texto(valor);
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Hora da célula como HH:MM:SS (arredonda o ruído de ponto flutuante). */
function textoHora(valor: ExcelJS.CellValue): string {
  const v = valorDaCelula(valor);
  let segundosNoDia: number | null = null;
  if (v instanceof Date) {
    segundosNoDia = Math.round((v.getTime() % 86_400_000) / 1000);
  } else if (typeof v === 'number') {
    segundosNoDia = Math.round((v % 1) * 86400);
  }
  if (segundosNoDia === null) return texto(valor);
  segundosNoDia = ((segundosNoDia % 86400) + 86400) % 86400;
  const hh = Math.floor(segundosNoDia / 3600);
  const mm = Math.floor((segundosNoDia % 3600) / 60);
  const ss = segundosNoDia % 60;
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}`;
}

function numero(valor: ExcelJS.CellValue): number | null {
  const v = valorDaCelula(valor);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = lerCreditos(texto(valor));
  return Number.isFinite(n) ? n : null;
}

function valoresDaLinha(linha: ExcelJS.Row): ExcelJS.CellValue[] {
  const valores: ExcelJS.CellValue[] = [];
  linha.eachCell({ includeEmpty: true }, (celula, coluna) => {
    valores[coluna - 1] = celula.value;
  });
  return valores;
}

function acharAba(
  livro: ExcelJS.Workbook,
  nome: string,
): ExcelJS.Worksheet | undefined {
  return livro.worksheets.find((a) => normalizarCabecalho(a.name) === nome);
}

interface ResumoBruto {
  premio: string;
  descricao: string | null;
  valorUnitario: number | null;
  quantidade: number | null;
  valorTotal: number | null;
}

/** Lê a aba Resumo (prêmio → descrição, valor, quantidade, total). */
function lerResumo(aba: ExcelJS.Worksheet | undefined): ResumoBruto[] {
  if (!aba) return [];
  const itens: ResumoBruto[] = [];
  let colunas: Record<string, number> | null = null;
  aba.eachRow({ includeEmpty: false }, (linha) => {
    const valores = valoresDaLinha(linha);
    if (!colunas) {
      const cab = valores.map((v) => normalizarCabecalho(texto(v)));
      const premio = cab.indexOf('premio');
      if (premio < 0) return;
      const achar = (prefixo: string) =>
        cab.findIndex((c) => c.startsWith(prefixo));
      colunas = {
        premio,
        descricao: cab.indexOf('descricao'),
        valorUnitario: achar('valorunitario'),
        quantidade: achar('quantidade'),
        valorTotal: achar('valortotal'),
      };
      return;
    }
    const premio = texto(valores[colunas.premio]);
    // Para na primeira linha sem prêmio, no "Total" ou nas observações.
    if (!premio || /^(total|observa)/.test(normalizarCabecalho(premio))) {
      colunas.premio = -1;
      return;
    }
    if (colunas.premio < 0) return;
    const ler = (i: number) => (i >= 0 ? numero(valores[i]) : null);
    itens.push({
      premio,
      descricao:
        colunas.descricao >= 0
          ? texto(valores[colunas.descricao]) || null
          : null,
      valorUnitario: ler(colunas.valorUnitario),
      quantidade: ler(colunas.quantidade),
      valorTotal: ler(colunas.valorTotal),
    });
  });
  return itens.filter((i) => i.premio);
}

/** Chave do prêmio: sem acento, espaços ou caixa ("Voucher R$ 120" = "voucher r$120"). */
const chavePremio = (premio: string) =>
  String(premio ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '');

/**
 * Lê o .xlsx do cronograma e valida cada linha com as mesmas regras do CSV.
 * Os números de linha são os da planilha (como o Excel mostra).
 */
export async function lerCronogramaXlsx(
  arquivo: Buffer,
  opcoes: OpcoesCronograma = {},
): Promise<CronogramaXlsxLido> {
  const vazio = (mensagem: string): CronogramaXlsxLido => ({
    aba: '',
    titulo: [],
    resumo: [],
    avisos: [],
    linhas: [],
    erros: [{ linha: 1, mensagem }],
  });

  const livro = new ExcelJS.Workbook();
  try {
    await livro.xlsx.load(arquivo as unknown as ArrayBuffer);
  } catch {
    return vazio('Arquivo .xlsx inválido ou corrompido');
  }
  const aba = acharAba(livro, 'cronograma') ?? livro.worksheets[0];
  if (!aba) return vazio('Planilha sem abas');

  let colunas: ColunasCronograma | null = null;
  let linhaCabecalho = 0;
  const titulo: string[] = [];
  const brutas: LinhaBrutaCronograma[] = [];
  aba.eachRow({ includeEmpty: false }, (linha, numeroLinha) => {
    const valores = valoresDaLinha(linha);
    if (!colunas) {
      if (numeroLinha > LINHAS_DE_TITULO_MAX) return;
      const mapa = mapearColunas(
        valores.map((v) => normalizarCabecalho(texto(v))),
      );
      if (mapa) {
        colunas = mapa;
        linhaCabecalho = numeroLinha;
      } else {
        const t = valores.map(texto).filter(Boolean).join(' ');
        if (t) titulo.push(t);
      }
      return;
    }
    const data = textoData(valores[colunas.data]);
    const hora = textoHora(valores[colunas.hora]);
    const creditos = texto(valores[colunas.creditos]);
    const descricao =
      colunas.descricao >= 0 ? texto(valores[colunas.descricao]) : null;
    if (!data && !hora && !creditos && !descricao) return;
    brutas.push({ linha: numeroLinha, data, hora, creditos, descricao });
  });

  if (!colunas) {
    return {
      ...vazio(
        `Cabeçalho do cronograma não encontrado na aba "${aba.name}" (esperado: Dia | Horário | Prêmio)`,
      ),
      aba: aba.name,
    };
  }

  // Com a aba Resumo, o valor unitário declarado define os créditos do prêmio.
  const resumoBruto = lerResumo(acharAba(livro, 'resumo'));
  const porPremio = new Map(resumoBruto.map((r) => [chavePremio(r.premio), r]));
  for (const b of brutas) {
    const declarado = porPremio.get(chavePremio(b.creditos));
    if (declarado?.valorUnitario && Number.isInteger(declarado.valorUnitario)) {
      b.creditos = String(declarado.valorUnitario);
    }
  }

  const lido = validarLinhasCronograma(brutas, opcoes);
  if (lido.linhas.length === 0 && lido.erros.length === 0) {
    lido.erros.push({
      linha: linhaCabecalho,
      mensagem: 'Nenhum momento na planilha',
    });
  }

  // Conferência Resumo × Cronograma (sobre as linhas válidas).
  const avisos: string[] = [];
  const contagem = new Map<string, { qtd: number; total: number }>();
  for (const l of lido.linhas) {
    const k = chavePremio(l.descricao ?? String(l.creditos));
    const c = contagem.get(k) ?? { qtd: 0, total: 0 };
    c.qtd++;
    c.total += l.creditos;
    contagem.set(k, c);
  }
  const resumo: ItemResumoCronograma[] = resumoBruto.map((r) => {
    const c = contagem.get(chavePremio(r.premio)) ?? { qtd: 0, total: 0 };
    if (r.quantidade !== null && r.quantidade !== c.qtd) {
      avisos.push(
        `"${r.premio}": o Resumo declara ${r.quantidade} e o cronograma tem ${c.qtd}`,
      );
    }
    if (r.valorTotal !== null && r.valorTotal !== c.total) {
      avisos.push(
        `"${r.premio}": o Resumo declara R$ ${r.valorTotal} e o cronograma soma ${c.total} créditos`,
      );
    }
    return {
      premio: r.premio,
      descricao: r.descricao,
      valorUnitario: r.valorUnitario,
      quantidadeDeclarada: r.quantidade,
      valorTotalDeclarado: r.valorTotal,
      quantidadeNoCronograma: c.qtd,
      valorTotalNoCronograma: c.total,
    };
  });
  if (resumoBruto.length > 0) {
    for (const [k, c] of contagem) {
      if (!porPremio.has(k)) {
        avisos.push(
          `${c.qtd} momento(s) com prêmio fora da aba Resumo (${k || 'sem descrição'})`,
        );
      }
    }
  }

  return { ...lido, aba: aba.name, titulo, resumo, avisos };
}
