import {
  PROHIBITED_KEYS_NORMALIZED,
  normalizeKey,
} from '../constants/analytics-prohibited-keys';

/**
 * Varre recursivamente um objeto e retorna as chaves proibidas encontradas.
 * A comparação é case-insensitive e normalizada (sem separadores).
 */
export function scanForProhibitedKeys(obj: unknown, path = ''): string[] {
  const found: string[] = [];

  if (obj === null || typeof obj !== 'object') {
    return found;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const nested = scanForProhibitedKeys(obj[i], `${path}[${i}]`);
      found.push(...nested);
    }
    return found;
  }

  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    const currentPath = path ? `${path}.${key}` : key;

    if (PROHIBITED_KEYS_NORMALIZED.has(normalized)) {
      found.push(currentPath);
    }

    const nested = scanForProhibitedKeys(
      (obj as Record<string, unknown>)[key],
      currentPath,
    );
    found.push(...nested);
  }

  return found;
}
