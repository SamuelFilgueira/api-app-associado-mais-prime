/**
 * Regra pura da posição unificada: como a data de um provedor vira instante
 * e qual posição vence quando mais de um provedor responde.
 */

/** Posição de um provedor, já com o instante calculado. */
export interface CandidatoDePosicao {
  origem: string;
  /** Instante da posição (ms). */
  timestamp: number;
}

/**
 * `preferido` vence `sobre` quando a diferença entre as duas posições é de
 * até `toleranciaMs`, mesmo que a de `sobre` seja a mais recente.
 */
export interface PreferenciaEntreProvedores {
  preferido: string;
  sobre: string;
  toleranciaMs: number;
}

/** A M7 tem prioridade sobre a Softruck dentro de uma janela de 1 h. */
export const PREFERENCIAS_ENTRE_PROVEDORES: readonly PreferenciaEntreProvedores[] =
  [{ preferido: 'm7', sobre: 'softruck', toleranciaMs: 60 * 60 * 1000 }];

/**
 * Converte a data de posição de um provedor em instante (ms).
 *
 * Aceita o que os três provedores mandam: ISO com `T` ou espaço
 * (`2026-08-31 10:00:00`, lido no fuso do processo) e o formato brasileiro
 * `dd/MM/yyyy HH:mm[:ss]`. Devolve `null` quando a data falta ou não é
 * reconhecida — o provedor fica fora da rodada.
 */
export function timestampDaPosicao(valor: unknown): number | null {
  if (typeof valor !== 'string' || !valor.trim()) return null;

  const texto = valor.trim();
  const nativo = Date.parse(texto.replace(' ', 'T'));
  if (!Number.isNaN(nativo)) return nativo;

  const br = texto.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!br) return null;

  const [, dia, mes, ano, hora, minuto, segundo] = br;
  const instante = new Date(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    Number(hora),
    Number(minuto),
    Number(segundo ?? '0'),
  ).getTime();
  return Number.isNaN(instante) ? null : instante;
}

/**
 * Escolhe a posição que vai ao app: a mais recente, salvo preferência entre
 * provedores. No empate de instante vence quem vem antes na lista.
 * Devolve `null` para lista vazia.
 */
export function escolherPosicao<T extends CandidatoDePosicao>(
  candidatos: readonly T[],
  preferencias: readonly PreferenciaEntreProvedores[] = PREFERENCIAS_ENTRE_PROVEDORES,
): T | null {
  if (candidatos.length === 0) return null;

  let escolhido = candidatos.reduce((maisRecente, candidato) =>
    candidato.timestamp > maisRecente.timestamp ? candidato : maisRecente,
  );

  for (const preferencia of preferencias) {
    if (escolhido.origem !== preferencia.sobre) continue;
    const preferido = candidatos.find(
      (c) => c.origem === preferencia.preferido,
    );
    if (
      preferido &&
      Math.abs(escolhido.timestamp - preferido.timestamp) <=
        preferencia.toleranciaMs
    ) {
      escolhido = preferido;
    }
  }

  return escolhido;
}

/** Latitude/longitude como número; `null` quando faltam ou não são números. */
export function coordenadasDaPosicao(
  latitude: unknown,
  longitude: unknown,
): { latitude: number; longitude: number } | null {
  const numero = (valor: unknown): number =>
    typeof valor === 'number'
      ? valor
      : typeof valor === 'string' && valor.trim()
        ? Number(valor.trim().replace(',', '.'))
        : Number.NaN;
  const lat = numero(latitude);
  const lon = numero(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? { latitude: lat, longitude: lon }
    : null;
}
