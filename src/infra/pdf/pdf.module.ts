import { Global, Module } from '@nestjs/common';
import { papelAtivo } from 'src/config/app.config';
import { ChromiumPdfRenderer } from 'src/infra/pdf/chromium-pdf.renderer';
import { PdfPelaFila } from 'src/infra/pdf/pdf-pela-fila.renderer';
import { PdfRenderProcessor } from 'src/infra/pdf/pdf-render.processor';
import { PdfRenderer } from 'src/infra/pdf/pdf-renderer';
import { paraPapel } from 'src/queue/queue.module';

/**
 * Renderização de PDF. A porta `PdfRenderer` é a mesma em todo papel; o que
 * muda é quem está atrás dela:
 *
 * - papel `pdf` (e `all`): o Chromium deste processo, com semáforo. No papel
 *   `pdf` o processor da fila também é registrado.
 * - papel `api` e `worker`: o pedido vai pela fila ao processo `pdf`.
 */
@Global()
@Module({
  providers: [
    ChromiumPdfRenderer,
    PdfPelaFila,
    {
      provide: PdfRenderer,
      useExisting: papelAtivo('pdf') ? ChromiumPdfRenderer : PdfPelaFila,
    },
    ...paraPapel('pdf', [PdfRenderProcessor]),
  ],
  exports: [PdfRenderer],
})
export class PdfModule {}
