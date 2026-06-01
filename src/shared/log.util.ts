export function baseTag(baseOrigin: string | undefined): string {
  if (!baseOrigin) return '[BASE:unknown]';
  return `[BASE:${baseOrigin}]`;
}

export function maskSecret(value?: string | null): string {
  if (!value) return '(vazio)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
