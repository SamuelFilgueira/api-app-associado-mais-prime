/**
 * Porta de renderização de PDF a partir de HTML.
 *
 * Os services de relatório montam o HTML e pedem o PDF por aqui; não sabem se
 * o Chromium está neste processo (papel `pdf` ou `all`) ou em outro (papel
 * `api`, que pede pela fila).
 */
export interface PedidoDePdf {
  html: string;
  /** Nome do relatório, para métrica e log. Conjunto fechado. */
  modelo: string;
  margem: { top: string; right: string; bottom: string; left: string };
  /** A4 deitado (padrão dos relatórios). */
  paisagem?: boolean;
}

export abstract class PdfRenderer {
  abstract renderizar(pedido: PedidoDePdf): Promise<Buffer>;
}

/** Dados do job da fila `pdf-render`: o HTML e o PDF trafegam por arquivo. */
export interface PdfJobData {
  /** Identificador do pedido: `<id>.html` entra, `<id>.pdf` sai. */
  id: string;
  modelo: string;
  margem: PedidoDePdf['margem'];
  paisagem: boolean;
}

export const JOB_RENDERIZAR_PDF = 'renderizar';
