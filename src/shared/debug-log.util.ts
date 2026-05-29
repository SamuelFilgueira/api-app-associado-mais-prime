export function debugLog(
  context: string,
  message: string,
  debugId?: string,
  meta?: Record<string, unknown>,
): string {
  return JSON.stringify({
    debugId: debugId?.trim() || 'SAMUEL_DEBUG',
    context,
    message,
    ...(meta ?? {}),
  });
}