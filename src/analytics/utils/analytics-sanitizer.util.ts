/** Clamp um inteiro entre min e max. */
export function clampInt(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Sanitiza app.version: trim e trunca no limite de caracteres. */
export function sanitizeVersionString(
  value: unknown,
  maxLen = 20,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().slice(0, maxLen);
}

export const CLAMP = {
  VIEW_COUNT: { min: 0, max: 9999 },
  TOTAL_TIME_MS: { min: 0, max: 3_600_000 },
  ACTION_COUNT: { min: 0, max: 9999 },
  FORM_COUNT: { min: 0, max: 9999 },
} as const;
