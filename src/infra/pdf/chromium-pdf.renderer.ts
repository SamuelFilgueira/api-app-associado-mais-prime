import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import puppeteer, { Browser } from 'puppeteer';
import { appConfig } from 'src/config/app.config';
import { metricas } from 'src/infra/observability/metricas';
import { PdfRenderer, PedidoDePdf } from 'src/infra/pdf/pdf-renderer';
import { IntegrationError } from 'src/shared/erros/erros';

/** Prazo de uma renderização (montar a página e imprimir). */
const PRAZO_RENDER_MS = 90_000;
/** Pedidos aguardando vaga além dos que estão renderizando. */
const MAX_NA_ESPERA = 20;
/** Depois de tantas páginas o Chromium é reiniciado (memória só cresce). */
const RECICLAR_APOS = 100;

/**
 * Único ponto do sistema que fala com o Chromium.
 *
 * Antes cada requisição de relatório lançava o próprio Chromium
 * (`puppeteer.launch` em quatro lugares), sem teto: quatro PDFs simultâneos
 * ocupavam as quatro vCPUs e centenas de MB cada, no mesmo processo que
 * atende o HTTP.
 *
 * Aqui há UM navegador, reaproveitado entre os pedidos, e um semáforo:
 *  - no máximo `PDF_CONCORRENCIA` páginas ao mesmo tempo;
 *  - até `MAX_NA_ESPERA` pedidos aguardam vaga; além disso o pedido é
 *    recusado na hora (melhor um erro rápido que uma fila sem fim);
 *  - cada renderização tem prazo;
 *  - o navegador é reaberto se cair e reciclado a cada `RECICLAR_APOS`
 *    páginas.
 */
@Injectable()
export class ChromiumPdfRenderer
  extends PdfRenderer
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(ChromiumPdfRenderer.name);
  private readonly concorrencia = appConfig().pdf.concorrencia;
  private navegador: Browser | null = null;
  private abrindo: Promise<Browser> | null = null;
  private emUso = 0;
  private readonly espera: Array<() => void> = [];
  private paginasDesdeOInicio = 0;
  private encerrando = false;

  async renderizar(pedido: PedidoDePdf): Promise<Buffer> {
    await this.adquirirVaga();
    const fim = Date.now();
    try {
      const pdf = await comPrazo(this.imprimir(pedido), PRAZO_RENDER_MS);
      metricas.pdfRenderizacoes.inc({ modelo: pedido.modelo, resultado: 'ok' });
      this.logger.log(
        `PDF ${pedido.modelo} renderizado em ${Date.now() - fim} ms (${pdf.length} bytes)`,
      );
      return pdf;
    } catch (erro) {
      const timeout = erro instanceof PrazoEsgotado;
      metricas.pdfRenderizacoes.inc({
        modelo: pedido.modelo,
        resultado: timeout ? 'timeout' : 'erro',
      });
      // Renderização presa ou navegador quebrado: descarta a instância para
      // o próximo pedido começar limpo.
      if (timeout || !this.navegador?.connected) await this.fecharNavegador();
      throw erro;
    } finally {
      this.liberarVaga();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.encerrando = true;
    await this.fecharNavegador();
  }

  /** Vagas em uso e pedidos na espera (para diagnóstico e teste). */
  estado(): { emUso: number; naEspera: number } {
    return { emUso: this.emUso, naEspera: this.espera.length };
  }

  private async imprimir(pedido: PedidoDePdf): Promise<Buffer> {
    const navegador = await this.obterNavegador();
    const pagina = await navegador.newPage();
    try {
      await pagina.setContent(pedido.html, {
        waitUntil: 'networkidle0',
        timeout: PRAZO_RENDER_MS,
      });
      const pdf = await pagina.pdf({
        format: 'A4',
        landscape: pedido.paisagem ?? true,
        printBackground: true,
        margin: pedido.margem,
        timeout: PRAZO_RENDER_MS,
      });
      return Buffer.from(pdf);
    } finally {
      this.paginasDesdeOInicio += 1;
      await pagina.close().catch(() => undefined);
    }
  }

  private async obterNavegador(): Promise<Browser> {
    if (this.navegador?.connected) return this.navegador;
    if (this.abrindo) return this.abrindo;

    this.abrindo = this.abrirNavegador()
      .then((navegador) => {
        this.navegador = navegador;
        this.paginasDesdeOInicio = 0;
        navegador.on('disconnected', () => {
          if (this.navegador === navegador) this.navegador = null;
        });
        return navegador;
      })
      .finally(() => {
        this.abrindo = null;
      });
    return this.abrindo;
  }

  /** Separado para os testes trocarem o Chromium por um dublê. */
  protected abrirNavegador(): Promise<Browser> {
    const executavel = appConfig().pdf.executavel;
    return puppeteer.launch({
      headless: true,
      ...(executavel && { executablePath: executavel }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }

  private async fecharNavegador(): Promise<void> {
    const navegador = this.navegador;
    this.navegador = null;
    if (!navegador) return;
    try {
      await navegador.close();
    } catch (erro) {
      this.logger.warn(
        `Falha ao fechar o Chromium: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  private adquirirVaga(): Promise<void> {
    if (this.emUso < this.concorrencia) {
      this.emUso += 1;
      return Promise.resolve();
    }
    if (this.espera.length >= MAX_NA_ESPERA) {
      return Promise.reject(
        new IntegrationError({
          vendor: 'pdf',
          tipo: 'indisponivel',
          message:
            'Muitos relatórios sendo gerados agora. Tente novamente em instantes.',
          detalhes: { emUso: this.emUso, naEspera: this.espera.length },
        }),
      );
    }
    return new Promise((resolver) => {
      this.espera.push(() => {
        this.emUso += 1;
        resolver();
      });
    });
  }

  private liberarVaga(): void {
    this.emUso -= 1;
    const proximo = this.espera.shift();
    if (proximo) {
      proximo();
      return;
    }
    // Sem ninguém usando nem esperando: hora segura de reciclar.
    if (
      this.emUso === 0 &&
      !this.encerrando &&
      this.paginasDesdeOInicio >= RECICLAR_APOS
    ) {
      void this.fecharNavegador();
    }
  }
}

class PrazoEsgotado extends Error {
  constructor(ms: number) {
    super(`Renderização do PDF excedeu ${ms / 1000}s`);
  }
}

function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(() => rejeitar(new PrazoEsgotado(ms)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => {
    if (temporizador) clearTimeout(temporizador);
  });
}
