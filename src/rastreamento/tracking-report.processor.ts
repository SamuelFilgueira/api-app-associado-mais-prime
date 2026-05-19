import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TRACKING_REPORT_QUEUE } from '../queue/queue.module';
import { RastreamentoService } from './rastreamento.service';
import { TrackingReportStorageService } from './tracking-report-storage.service';
import { TrackingReportJobData } from './tracking-report.types';

@Processor(TRACKING_REPORT_QUEUE, { concurrency: 1 })
export class TrackingReportProcessor extends WorkerHost {
  private readonly logger = new Logger(TrackingReportProcessor.name);

  constructor(
    private readonly rastreamentoService: RastreamentoService,
    private readonly trackingReportStorage: TrackingReportStorageService,
  ) {
    super();
  }

  async process(job: Job<TrackingReportJobData>): Promise<{ message: string }> {
    const startedAt = Date.now();

    this.logger.log(
      `[TRACKING_REPORT] ▶ job #${job.id} chassi=${job.data.chassi} período=${job.data.dataInicial}-${job.data.dataFinal}`,
    );

    await this.trackingReportStorage.markProcessing(String(job.id));

    const pdfBuffer = await this.rastreamentoService.obterTrajetoriasSoftruck(
      job.data.chassi,
      job.data.dataInicial,
      job.data.dataFinal,
      job.data.baseOrigin,
      job.data.publicKey,
    );

    await this.trackingReportStorage.saveCompletedReport(
      String(job.id),
      pdfBuffer,
      job.data,
    );

    const elapsed = Date.now() - startedAt;
    this.logger.log(
      `[TRACKING_REPORT] ✔ job #${job.id} concluído em ${elapsed}ms`,
    );

    return { message: 'Relatório processado com sucesso' };
  }

  @OnWorkerEvent('active')
  onActive(job: Job<TrackingReportJobData>): void {
    this.logger.log(
      `[TRACKING_REPORT] ⚙ job #${job.id} ativo (tentativa ${job.attemptsMade + 1})`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<TrackingReportJobData>, error: Error): Promise<void> {
    this.logger.error(
      `[TRACKING_REPORT] ✖ job #${job.id} falhou: ${error.message}`,
    );
    await this.trackingReportStorage.markFailed(String(job.id), error.message);
  }
}
