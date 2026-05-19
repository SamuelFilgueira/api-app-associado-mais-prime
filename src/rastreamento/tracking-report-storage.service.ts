import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { RedisService } from './redis.service';
import { TrackingReportJobData, TrackingReportRecord } from './tracking-report.types';

const TRACKING_REPORT_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class TrackingReportStorageService {
  private readonly logger = new Logger(TrackingReportStorageService.name);
  private readonly reportsDir = path.join(
    process.cwd(),
    'uploads',
    'tracking-reports',
  );

  constructor(private readonly redisService: RedisService) {}

  async markQueued(jobId: string, data: TrackingReportJobData): Promise<void> {
    const now = new Date().toISOString();
    await this.saveRecord(jobId, {
      jobId,
      status: 'queued',
      chassi: data.chassi,
      dataInicial: data.dataInicial,
      dataFinal: data.dataFinal,
      baseOrigin: data.baseOrigin,
      createdAt: now,
      updatedAt: now,
    });
  }

  async markProcessing(jobId: string): Promise<void> {
    const record = await this.getRecord(jobId);
    const now = new Date().toISOString();

    if (!record) {
      return;
    }

    await this.saveRecord(jobId, {
      ...record,
      status: 'processing',
      startedAt: record.startedAt ?? now,
      updatedAt: now,
    });
  }

  async saveCompletedReport(
    jobId: string,
    buffer: Buffer,
    data: TrackingReportJobData,
  ): Promise<TrackingReportRecord> {
    await mkdir(this.reportsDir, { recursive: true });

    const safeChassi = (data.chassi || 'veiculo').replace(/[^A-Za-z0-9_-]/g, '');
    const fileName = `trajetorias-${safeChassi || 'veiculo'}-${data.dataInicial}-${data.dataFinal}-${jobId}.pdf`;
    const absolutePath = path.join(this.reportsDir, fileName);
    const relativePath = path.posix.join('uploads', 'tracking-reports', fileName);
    const downloadUrl = `/${relativePath}`;
    const now = new Date().toISOString();
    const current = await this.getRecord(jobId);

    await writeFile(absolutePath, buffer);

    const record: TrackingReportRecord = {
      jobId,
      status: 'completed',
      chassi: data.chassi,
      dataInicial: data.dataInicial,
      dataFinal: data.dataFinal,
      baseOrigin: data.baseOrigin,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      startedAt: current?.startedAt ?? now,
      completedAt: now,
      fileName,
      relativePath,
      downloadUrl,
      sizeInBytes: buffer.length,
    };

    await this.saveRecord(jobId, record);
    this.logger.log(`[REPORT] job #${jobId} salvo em ${relativePath}`);
    return record;
  }

  async markFailed(jobId: string, error: string): Promise<void> {
    const record = await this.getRecord(jobId);
    const now = new Date().toISOString();

    if (!record) {
      return;
    }

    await this.saveRecord(jobId, {
      ...record,
      status: 'failed',
      failedAt: now,
      error,
      updatedAt: now,
    });
  }

  async getRecord(jobId: string): Promise<TrackingReportRecord | null> {
    const value = await this.redisService
      .getClient()
      .get(this.buildRedisKey(jobId));

    if (!value) {
      return null;
    }

    return JSON.parse(value) as TrackingReportRecord;
  }

  async getCompletedReportFile(
    jobId: string,
  ): Promise<{ record: TrackingReportRecord; buffer: Buffer } | null> {
    const record = await this.getRecord(jobId);

    if (!record?.relativePath || record.status !== 'completed') {
      return null;
    }

    const absolutePath = path.join(process.cwd(), record.relativePath);
    const buffer = await readFile(absolutePath);

    return { record, buffer };
  }

  private async saveRecord(
    jobId: string,
    record: TrackingReportRecord,
  ): Promise<void> {
    await this.redisService
      .getClient()
      .set(
        this.buildRedisKey(jobId),
        JSON.stringify(record),
        'EX',
        TRACKING_REPORT_TTL_SECONDS,
      );
  }

  private buildRedisKey(jobId: string): string {
    return `tracking-report:job:${jobId}`;
  }
}
