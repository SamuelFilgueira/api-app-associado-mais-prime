/**
 * Ordem do template no nome do arquivo que o app envia
 * (`revistoria_ordem_3_1.jpg`, `ordem-12.jpg`, `ordem7.png`).
 */
export function extrairOrdemDoNomeArquivo(nomeArquivo: string): number | null {
  const achado = /ordem[_-]?(\d+)/i.exec(nomeArquivo);
  if (!achado) return null;
  const ordem = Number.parseInt(achado[1], 10);
  return Number.isNaN(ordem) ? null : ordem;
}

/** Foto do lote sem nome ou sem conteúdo. */
export function fotoIncompleta(foto: {
  nomeArquivo?: string;
  binario?: string;
}): boolean {
  return !foto.nomeArquivo || !foto.binario;
}

/** Limite da listagem do painel: 20 por padrão, no máximo 100. */
export function limiteDaListagem(pedido?: number): number {
  return Math.min(pedido ?? 20, 100);
}

/** Termos de busca por chassi/placa, sem espaços nas pontas. */
export function termosDeBusca(
  chassi?: string,
  plate?: string,
): { chassi?: string; plate?: string } | null {
  const c = chassi?.trim();
  const p = plate?.trim();
  if (!c && !p) return null;
  return { ...(c ? { chassi: c } : {}), ...(p ? { plate: p } : {}) };
}
