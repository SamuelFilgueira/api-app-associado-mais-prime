export function baseTag(baseOrigin: string | undefined): string {
  if (!baseOrigin) return '[BASE:unknown]';
  return `[BASE:${baseOrigin}]`;
}
