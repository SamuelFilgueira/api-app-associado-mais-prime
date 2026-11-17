import { createHash } from 'crypto';

/**
 * Cronograma de momentos premiados: leitura da planilha do marketing e hash
 * de auditoria. Funções puras e isoladas aqui de propósito: o formato da
 * planilha pode mudar, e só este arquivo (com o spec) precisa mudar. A
 * leitura do .xlsx fica em `sorte-cronograma-xlsx.helper.ts` e reaproveita
 * `validarLinhasCronograma`.
 *
 * Colunas aceitas (cabeçalho em qualquer ordem, sem diferenciar maiúsculas
 * ou acentos; linhas de título antes do cabeçalho são ignoradas):
 *  - data:      `data` ou `dia` — DD/MM/AAAA;
 *  - hora:      `hora` ou `horario` — HH:MM ou HH:MM:SS (Brasília);
 *  - créditos:  `creditos` ou `valor` — inteiro > 0; sem essa coluna, o valor
 *    sai do `premio` ("Voucher R$120" → 120);
 *  - descrição: `descricao` (opcional); sem essa coluna, vale o `premio`.
 * Planilha oficial (13/11/2026): `Dia | Horário | Prêmio` (ex.:
 * `14/12/2026 | 09:40:31 | Voucher R$120`). CSV: separador `;` ou `,`,
 * campos entre aspas e BOM são aceitos; linhas em branco são ignoradas.
 */

export interface LinhaCronograma {
  /** Número da linha no arquivo (1 = primeira linha). */
  linha: number;
  liberaEm: Date;
  creditos: number;
  descricao: string | null;
}

export interface ErroCronograma {
  linha: number;
  mensagem: string;
}

export interface CronogramaLido {
  linhas: LinhaCronograma[];
  erros: ErroCronograma[];
}

/** Linha já separada em campos de texto, antes da validação. */
export interface LinhaBrutaCronograma {
  linha: number;
  data: string;
  hora: string;
  creditos: string;
  descricao: string | null;
}

export interface OpcoesCronograma {
  periodo?: { inicio: Date; fim: Date };
  existentes?: {
    liberaEm: Date;
    creditos: number;
    descricao: string | null;
  }[];
  maxLinhas?: number;
}

const OFFSET_BRASILIA = '-03:00';
const LINHAS_DE_TITULO_MAX = 20;
const COLUNAS_ESPERADAS =
  'Dia;Horário;Prêmio (ou data;hora;creditos;descricao)';

export function normalizarCabecalho(valor: string): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export interface ColunasCronograma {
  data: number;
  hora: number;
  creditos: number;
  descricao: number;
}

/**
 * Posição de cada coluna num cabeçalho já normalizado, ou `null` se faltar
 * data, hora ou a origem dos créditos (`creditos`/`valor`/`premio`).
 */
export function mapearColunas(cabecalho: string[]): ColunasCronograma | null {
  const primeira = (...nomes: string[]) => {
    for (const n of nomes) {
      const i = cabecalho.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const data = primeira('data', 'dia');
  const hora = primeira('hora', 'horario');
  const premio = primeira('premio');
  const creditos = primeira('creditos', 'credito', 'valor');
  const descricao = primeira('descricao');
  const colunas = {
    data,
    hora,
    creditos: creditos >= 0 ? creditos : premio,
    descricao: descricao >= 0 ? descricao : premio,
  };
  return colunas.data < 0 || colunas.hora < 0 || colunas.creditos < 0
    ? null
    : colunas;
}

/** Divide uma linha respeitando aspas duplas ("a;b" e "" como aspas literais). */
export function dividirLinhaCsv(linha: string, separador: string): string[] {
  const campos: string[] = [];
  let atual = '';
  let entreAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (entreAspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') {
          atual += '"';
          i++;
        } else {
          entreAspas = false;
        }
      } else {
        atual += c;
      }
    } else if (c === '"') {
      entreAspas = true;
    } else if (c === separador) {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos.map((c) => c.trim());
}

const RE_HORA = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** "DD/MM/AAAA" + "HH:MM[:SS]" (Brasília) → instante, ou `null` se inválido. */
export function lerDataHoraBrasilia(data: string, hora: string): Date | null {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(data.trim());
  const h = RE_HORA.exec(hora.trim());
  if (!d || !h) return null;
  const [dia, mes, ano] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hh, mm, ss] = [Number(h[1]), Number(h[2]), Number(h[3] ?? 0)];
  if (mes < 1 || mes > 12 || dia < 1 || hh > 23 || mm > 59 || ss > 59) {
    return null;
  }
  // Confere se o dia existe no mês (ex.: 31/02).
  const calendario = new Date(Date.UTC(ano, mes - 1, dia));
  if (calendario.getUTCMonth() !== mes - 1 || calendario.getUTCDate() !== dia) {
    return null;
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  return new Date(
    `${ano}-${p2(mes)}-${p2(dia)}T${p2(hh)}:${p2(mm)}:${p2(ss)}.000${OFFSET_BRASILIA}`,
  );
}

function horaValida(hora: string): boolean {
  const m = RE_HORA.exec(hora.trim());
  return (
    !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59 && Number(m[3] ?? 0) <= 59
  );
}

/**
 * Créditos de um campo: "120", "R$ 120,00", "Voucher R$120", "1.200".
 * Devolve `NaN` se não houver número ou se houver centavos (créditos são
 * inteiros: 1 crédito = R$ 1).
 */
export function lerCreditos(texto: string): number {
  const limpo = String(texto ?? '').trim();
  if (/^\d+$/.test(limpo)) return Number(limpo);
  const m = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/.exec(limpo);
  if (!m) return NaN;
  if (m[2] && Number(m[2]) !== 0) return NaN;
  return Number(m[1].replace(/\./g, ''));
}

/**
 * Valida as linhas já separadas em campos. Com `periodo`, recusa horários
 * fora de [inicio, fim]. Linhas idênticas (mesmo horário, créditos e
 * descrição) são recusadas como duplicadas, inclusive contra `existentes`.
 */
export function validarLinhasCronograma(
  brutas: LinhaBrutaCronograma[],
  opcoes: OpcoesCronograma = {},
): CronogramaLido {
  const erros: ErroCronograma[] = [];
  const linhas: LinhaCronograma[] = [];

  const chave = (liberaEm: Date, creditos: number, descricao: string | null) =>
    `${liberaEm.getTime()}|${creditos}|${(descricao ?? '').toLowerCase()}`;
  const vistas = new Map<string, number>();
  for (const e of opcoes.existentes ?? []) {
    vistas.set(chave(e.liberaEm, e.creditos, e.descricao), 0);
  }

  const maxLinhas = opcoes.maxLinhas ?? Number.POSITIVE_INFINITY;
  let contadas = 0;
  for (const bruta of brutas) {
    const numero = bruta.linha;
    contadas++;
    if (contadas > maxLinhas) {
      erros.push({
        linha: numero,
        mensagem: `O arquivo passa do limite de ${maxLinhas} linhas`,
      });
      break;
    }
    const data = bruta.data.trim();
    const hora = bruta.hora.trim();
    const creditosTexto = bruta.creditos.trim();
    const descricao = (bruta.descricao ?? '').trim() || null;

    const problemas: string[] = [];
    const liberaEm = lerDataHoraBrasilia(data, hora);
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(data)) {
      problemas.push(`data inválida "${data}" (use DD/MM/AAAA)`);
    } else if (!horaValida(hora)) {
      problemas.push(`hora inválida "${hora}" (use HH:MM ou HH:MM:SS)`);
    } else if (!liberaEm) {
      problemas.push(`data/hora inexistente "${data} ${hora}"`);
    }
    const creditos = lerCreditos(creditosTexto);
    if (!Number.isSafeInteger(creditos) || creditos <= 0) {
      problemas.push(
        `créditos inválidos "${creditosTexto}" (inteiro maior que zero)`,
      );
    }
    if (descricao && descricao.length > 200) {
      problemas.push('descrição com mais de 200 caracteres');
    }
    if (liberaEm && opcoes.periodo) {
      const { inicio, fim } = opcoes.periodo;
      if (
        liberaEm.getTime() < inicio.getTime() ||
        liberaEm.getTime() > fim.getTime()
      ) {
        problemas.push('horário fora do período da campanha');
      }
    }
    if (problemas.length === 0 && liberaEm) {
      const k = chave(liberaEm, creditos, descricao);
      const anterior = vistas.get(k);
      if (anterior !== undefined) {
        problemas.push(
          anterior === 0
            ? 'momento já existe no cronograma'
            : `linha duplicada (igual à linha ${anterior})`,
        );
      } else {
        vistas.set(k, numero);
      }
    }

    if (problemas.length > 0) {
      erros.push({ linha: numero, mensagem: problemas.join('; ') });
    } else {
      linhas.push({ linha: numero, liberaEm: liberaEm!, creditos, descricao });
    }
  }
  return { linhas, erros };
}

/** Lê o CSV (ver formatos no topo do arquivo) e valida cada linha. */
export function lerCronogramaCsv(
  texto: string,
  opcoes: OpcoesCronograma = {},
): CronogramaLido {
  const brutas = String(texto ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/);

  const primeira = brutas.findIndex((l) => l.trim() !== '');
  if (primeira < 0) {
    return { linhas: [], erros: [{ linha: 1, mensagem: 'Arquivo vazio' }] };
  }
  // O cabeçalho é a primeira linha (até LINHAS_DE_TITULO_MAX) com as colunas.
  let indiceCabecalho = -1;
  let separador = ';';
  let colunas: ColunasCronograma | null = null;
  for (
    let i = primeira;
    i < Math.min(brutas.length, primeira + LINHAS_DE_TITULO_MAX) && !colunas;
    i++
  ) {
    for (const sep of [';', ',', '\t']) {
      const mapa = mapearColunas(
        dividirLinhaCsv(brutas[i], sep).map(normalizarCabecalho),
      );
      if (mapa) {
        colunas = mapa;
        separador = sep;
        indiceCabecalho = i;
        break;
      }
    }
  }
  if (!colunas) {
    return {
      linhas: [],
      erros: [
        {
          linha: primeira + 1,
          mensagem: `Cabeçalho do cronograma não encontrado (esperado: ${COLUNAS_ESPERADAS})`,
        },
      ],
    };
  }

  const linhasBrutas: LinhaBrutaCronograma[] = [];
  for (let i = indiceCabecalho + 1; i < brutas.length; i++) {
    if (brutas[i].trim() === '') continue;
    const campos = dividirLinhaCsv(brutas[i], separador);
    linhasBrutas.push({
      linha: i + 1,
      data: campos[colunas.data] ?? '',
      hora: campos[colunas.hora] ?? '',
      creditos: campos[colunas.creditos] ?? '',
      descricao:
        colunas.descricao >= 0 ? (campos[colunas.descricao] ?? '') : null,
    });
  }
  const lido = validarLinhasCronograma(linhasBrutas, opcoes);
  if (lido.linhas.length === 0 && lido.erros.length === 0) {
    lido.erros.push({
      linha: indiceCabecalho + 1,
      mensagem: 'Nenhum momento no arquivo',
    });
  }
  return lido;
}

/**
 * Valida de novo linhas já lidas (dentro da transação de importação, contra
 * o período e os momentos existentes naquele instante).
 */
export function revalidarCronograma(
  linhas: LinhaCronograma[],
  opcoes: OpcoesCronograma,
): CronogramaLido {
  return validarLinhasCronograma(
    linhas.map((l) => {
      const [data, hora] = dataHoraBrasilia(l.liberaEm).split(' ');
      return {
        linha: l.linha,
        data,
        hora,
        creditos: String(l.creditos),
        descricao: l.descricao,
      };
    }),
    opcoes,
  );
}

/** Primeiro e último horário do arquivo (para conferir com o período). */
export function periodoDasLinhas(
  linhas: LinhaCronograma[],
): { primeiro: Date; ultimo: Date } | null {
  if (linhas.length === 0) return null;
  let primeiro = linhas[0].liberaEm;
  let ultimo = linhas[0].liberaEm;
  for (const l of linhas) {
    if (l.liberaEm < primeiro) primeiro = l.liberaEm;
    if (l.liberaEm > ultimo) ultimo = l.liberaEm;
  }
  return { primeiro, ultimo };
}

// ------------------------------------------------------------------- hash

export interface CampanhaParaHash {
  id: number;
  baseOrigin: string;
  inicio: Date;
  fim: Date;
}

export interface MomentoParaHash {
  id: number;
  liberaEm: Date;
  creditos: number;
  descricao: string | null;
}

/**
 * Texto canônico do cronograma (o que entra no SHA-256). Documentado em
 * `docs/ASSOCIADO_DA_SORTE.md` para que a auditoria consiga recalcular:
 *
 *   campanha=<id>
 *   base=<baseOrigin>
 *   inicio=<ISO UTC>
 *   fim=<ISO UTC>
 *   <liberaEm ISO UTC>;<creditos>;<descricao>   (uma por momento, em ordem de liberaEm e id)
 */
export function textoCanonicoDoCronograma(
  campanha: CampanhaParaHash,
  momentos: MomentoParaHash[],
): string {
  const ordenados = [...momentos].sort(
    (a, b) => a.liberaEm.getTime() - b.liberaEm.getTime() || a.id - b.id,
  );
  return [
    `campanha=${campanha.id}`,
    `base=${campanha.baseOrigin}`,
    `inicio=${campanha.inicio.toISOString()}`,
    `fim=${campanha.fim.toISOString()}`,
    ...ordenados.map(
      (m) =>
        `${m.liberaEm.toISOString()};${m.creditos};${(m.descricao ?? '').replace(/[\r\n;]/g, ' ')}`,
    ),
  ].join('\n');
}

export function hashCronograma(
  campanha: CampanhaParaHash,
  momentos: MomentoParaHash[],
): string {
  return createHash('sha256')
    .update(textoCanonicoDoCronograma(campanha, momentos), 'utf8')
    .digest('hex');
}

// --------------------------------------------------------------- formatos

const FORMATADOR_BRASILIA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** "DD/MM/AAAA HH:MM:SS" em Brasília (CSV de auditoria e e-mail). */
export function dataHoraBrasilia(valor: Date | null | undefined): string {
  if (!valor) return '';
  return FORMATADOR_BRASILIA.format(valor).replace(',', '');
}

/** Campo de CSV com `;`: aspas quando precisa. */
export function campoCsv(valor: unknown): string {
  const texto =
    valor === null || valor === undefined
      ? ''
      : typeof valor === 'object'
        ? JSON.stringify(valor)
        : String(valor as string | number | boolean);
  return /[;"\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}
