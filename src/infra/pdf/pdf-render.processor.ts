import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { promises as fs } from 'fs';
import { join } from 'path';
import { appConfig } from 'src/config/app.config';
import { ChromiumPdfRenderer } from 'src/infra/pdf/chromium-pdf.renderer';
import { PdfJobData } from 'src/infra/pdf/pdf-renderer';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { PDF_QUEUE } from 'src/queue/filas';
import { ProcessadorBase } from 'src/queue/processador-base';
import { DomainError } from 'src/shared/erros/erros';

/**
 * Consumidor da fila `pdf-render`, registrado só no papel `pdf`. Lê o HTML
 * do diretório de troca, renderiza no Chromium deste processo e grava o PDF
 * ao lado.
 */
@Processor(PDF_QUEUE, { concurrency: appConfig().pdf.concorrencia })
export class PdfRenderProcessor extends ProcessadorBase<
  PdfJobData,
  { bytes: number }
> {
  protected readonly logger = new Logger(PdfRenderProcessor.name);
  // Quem pediu o PDF está esperando e recebe o erro na hora; o HTML do
  // pedido é apagado em seguida, então um morto não teria o que reprocessar.
  protected readonly usaFilaDeMortos = false;

  constructor(
    private readonly chromium: ChromiumPdfRenderer,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected async executar(job: Job<PdfJobData>): Promise<{ bytes: number }> {
    const { id, modelo, margem, paisagem } = job.data;
    // O id vira nome de arquivo: só o formato de UUID é aceito.
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new DomainError('PDF_PEDIDO_INVALIDO', 'Pedido de PDF inválido');
    }

    const diretorio = appConfig().pdf.diretorioDeTroca;
    let html: string;
    try {
      html = await fs.readFile(join(diretorio, `${id}.html`), 'utf8');
    } catch {
      // Quem pediu desistiu (prazo) e já apagou o HTML: não há o que repetir.
      throw new DomainError(
        'PDF_PEDIDO_EXPIRADO',
        'O pedido de PDF expirou antes de ser atendido',
      );
    }

    const pdf = await this.chromium.renderizar({
      html,
      modelo,
      margem,
      paisagem,
    });
    await fs.writeFile(join(diretorio, `${id}.pdf`), pdf);
    return { bytes: pdf.length };
  }
}
