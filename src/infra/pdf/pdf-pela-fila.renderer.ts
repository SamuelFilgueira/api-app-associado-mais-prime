import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { appConfig } from 'src/config/app.config';
import {
  JOB_RENDERIZAR_PDF,
  PdfJobData,
  PdfRenderer,
  PedidoDePdf,
} from 'src/infra/pdf/pdf-renderer';
import { PDF_QUEUE } from 'src/queue/filas';
import { comEnvelope } from 'src/queue/job-envelope';
import { IntegrationError } from 'src/shared/erros/erros';

/**
 * Renderização de PDF para o processo que NÃO tem o Chromium (papel `api`).
 *
 * O pedido vai pela fila `pdf-render` e a rota continua devolvendo o PDF na
 * mesma requisição: a API grava o HTML no diretório de troca, enfileira o
 * job e espera por ele com prazo; o processo `pdf` grava o PDF no mesmo
 * diretório. Só o identificador passa pelo Redis.
 *
 * Assim o HTTP nunca divide processo com o Chromium, a fila absorve o pico
 * e `queue_jobs{queue="pdf-render"}` mostra quando falta capacidade.
 */
@Injectable()
export class PdfPelaFila extends PdfRenderer implements OnApplicationShutdown {
  private readonly logger = new Logger(PdfPelaFila.name);
  private eventos: QueueEvents | null = null;

  constructor(
    @InjectQueue(PDF_QUEUE) private readonly fila: Queue<PdfJobData>,
  ) {
    super();
  }

  async renderizar(pedido: PedidoDePdf): Promise<Buffer> {
    const { diretorioDeTroca, prazoMs } = appConfig().pdf;
    const id = randomUUID();
    const html = join(diretorioDeTroca, `${id}.html`);
    const pdf = join(diretorioDeTroca, `${id}.pdf`);

    await fs.mkdir(diretorioDeTroca, { recursive: true });
    await fs.writeFile(html, pedido.html, 'utf8');

    try {
      const job = await this.fila.add(
        JOB_RENDERIZAR_PDF,
        comEnvelope({
          id,
          modelo: pedido.modelo,
          margem: pedido.margem,
          paisagem: pedido.paisagem ?? true,
        }),
        { jobId: id },
      );

      try {
        await job.waitUntilFinished(this.obterEventos(), prazoMs);
      } catch (erro) {
        // Prazo esgotado com o job ainda na fila: tira-o de lá para o
        // processo `pdf` não renderizar um relatório que ninguém espera.
        await job.remove().catch(() => undefined);
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        throw new IntegrationError({
          vendor: 'pdf',
          tipo: /timed out/i.test(mensagem) ? 'timeout' : 'indisponivel',
          message:
            'Não foi possível gerar o relatório agora. Tente novamente em instantes.',
          detalhes: { modelo: pedido.modelo, motivo: mensagem.slice(0, 300) },
          causa: erro,
        });
      }

      return await fs.readFile(pdf);
    } finally {
      await Promise.all([
        fs.unlink(html).catch(() => undefined),
        fs.unlink(pdf).catch(() => undefined),
      ]);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.eventos?.close().catch(() => undefined);
  }

  /** Um `QueueEvents` por processo, criado no primeiro pedido. */
  private obterEventos(): QueueEvents {
    if (!this.eventos) {
      // Mesma conexão e mesmo prefixo da fila injetada.
      this.eventos = new QueueEvents(this.fila.name, {
        connection: this.fila.opts.connection,
        prefix: this.fila.opts.prefix,
      });
      this.eventos.on('error', (erro) => {
        this.logger.warn(`Eventos da fila de PDF: ${erro.message}`);
      });
    }
    return this.eventos;
  }
}
