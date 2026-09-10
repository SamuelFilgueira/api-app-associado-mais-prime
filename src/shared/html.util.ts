/**
 * Escapa caracteres especiais de HTML para interpolação segura em templates
 * (relatórios PDF). Antes duplicado literal nos PDFs de M7, Lógica e Softruck.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
