import { createHash } from 'crypto';

/**
 * Regra pura do webhook da M7: o que identifica um evento, o hash que barra
 * a reentrega e quando um evento atrasado é descartado.
 */

/** Campos do payload que o rastreamento usa. */
export interface EventoM7 {
  /** Chassi do veículo; vazio quando o payload não é de veículo. */
  chassi: string;
  evento: string | null;
  tipoevento: number | null;
  /** Canal da entrega (`cliente`, `empresa`); não identifica o evento. */
  scope: string | null;
  /** Código do evento na M7. */
  codigo: string | null;
  /** Instante do evento (`enviado_em`), em ms; `null` se ausente ou inválido. */
  enviadoEm: number | null;
  /** SHA-256 (hex) dos campos que identificam o evento. */
  hash: string;
}

function texto(valor: unknown): string | null {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return null;
}

/** JSON com as chaves em ordem: o mesmo objeto dá sempre o mesmo texto. */
function jsonEstavel(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const objeto = valor as Record<string, unknown>;
    return `{${Object.keys(objeto)
      .sort()
      .map((chave) => `${JSON.stringify(chave)}:${jsonEstavel(objeto[chave])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

function sha256(conteudo: string): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

/** Instante de `enviado_em`; `null` quando falta ou não é uma data. */
export function instanteDoEvento(valor: unknown): number | null {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  const instante = Date.parse(valor.trim().replace(' ', 'T'));
  return Number.isNaN(instante) ? null : instante;
}

/**
 * Lê o payload do webhook. Nunca lança: payload que não é objeto vira um
 * evento sem chassi (nada a gravar nem a notificar).
 *
 * O hash sai dos campos que identificam o EVENTO — chassi, tipo, descrição,
 * código e data de envio. O `scope` fica de fora: a M7 entrega o mesmo
 * evento uma vez por canal, e são a mesma ocorrência. Payload sem chassi
 * (aviso que não é de veículo, teste) é identificado pelo conteúdo inteiro.
 */
export function extrairEventoM7(payload: unknown): EventoM7 {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      chassi: '',
      evento: null,
      tipoevento: null,
      scope: null,
      codigo: null,
      enviadoEm: null,
      hash: sha256(`m7|bruto|${jsonEstavel(payload ?? null)}`),
    };
  }

  const p = payload as Record<string, unknown>;
  const chassi = typeof p.chassi === 'string' ? p.chassi : '';
  const evento = typeof p.evento === 'string' ? p.evento : null;
  const tipoBruto = Number(p.tipoevento);
  const tipoevento = Number.isNaN(tipoBruto) ? null : tipoBruto;
  const scope =
    typeof p.scope === 'string' ? p.scope.trim().toLowerCase() : null;
  const codigo = texto(p.codigo)?.trim() || null;
  const enviadoEmBruto = texto(p.enviado_em)?.trim() ?? '';

  const identidade = chassi.trim()
    ? [
        'm7',
        'veiculo',
        chassi.trim().toUpperCase(),
        tipoevento ?? '',
        (evento ?? '').trim().toLowerCase(),
        codigo ?? '',
        enviadoEmBruto,
      ].join('|')
    : `m7|bruto|${jsonEstavel(p)}`;

  return {
    chassi,
    evento,
    tipoevento,
    scope,
    codigo,
    enviadoEm: instanteDoEvento(enviadoEmBruto),
    hash: sha256(identidade),
  };
}

/** Id do job da fila para o evento. Não contém `:` (restrição do BullMQ). */
export function idDoJobDoEventoM7(hash: string): string {
  return `m7-${hash}`;
}

/**
 * O evento é mais antigo que o último já processado para o mesmo veículo e
 * tipo? Sem as duas datas não há como afirmar — e, na dúvida, o alerta sai.
 */
export function ehEventoAtrasado(
  enviadoEm: number | null,
  ultimoProcessadoEm: number | null,
): boolean {
  if (enviadoEm === null || ultimoProcessadoEm === null) return false;
  return enviadoEm < ultimoProcessadoEm;
}
