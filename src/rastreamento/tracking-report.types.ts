import { BaseOrigin } from 'src/shared/token-resolver.service';

export interface TrackingReportJobData {
  chassi: string;
  dataInicial: string;
  dataFinal: string;
  baseOrigin: BaseOrigin;
  publicKey: string;
}

export type TrackingReportJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export interface TrackingReportRecord {
  jobId: string;
  status: TrackingReportJobStatus;
  chassi: string;
  dataInicial: string;
  dataFinal: string;
  baseOrigin: BaseOrigin;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  fileName?: string;
  relativePath?: string;
  downloadUrl?: string;
  sizeInBytes?: number;
}
