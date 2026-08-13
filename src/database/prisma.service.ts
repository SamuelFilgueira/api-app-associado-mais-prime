import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const PRISMA_CONNECTION_LIMIT_RAW = Number(
  process.env.PRISMA_CONNECTION_LIMIT ?? 40,
);
const PRISMA_POOL_TIMEOUT_RAW = Number(process.env.PRISMA_POOL_TIMEOUT ?? 30);
const PRISMA_CONNECTION_LIMIT = Number.isFinite(PRISMA_CONNECTION_LIMIT_RAW)
  ? Math.max(1, Math.trunc(PRISMA_CONNECTION_LIMIT_RAW))
  : 40;
const PRISMA_POOL_TIMEOUT = Number.isFinite(PRISMA_POOL_TIMEOUT_RAW)
  ? Math.max(1, Math.trunc(PRISMA_POOL_TIMEOUT_RAW))
  : 30;

function montarDatabaseUrlComPool(
  databaseUrl: string | undefined,
): string | undefined {
  if (!databaseUrl) return undefined;

  try {
    const url = new URL(databaseUrl);

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(PRISMA_CONNECTION_LIMIT));
    }

    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', String(PRISMA_POOL_TIMEOUT));
    }

    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function montarPrismaOptions(): Prisma.PrismaClientOptions | undefined {
  const databaseUrl = montarDatabaseUrlComPool(process.env.DATABASE_URL);
  if (!databaseUrl) return undefined;

  return {
    datasources: {
      db: { url: databaseUrl },
    },
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super(montarPrismaOptions());
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log(
      `Prisma connected to database (connection_limit=${PRISMA_CONNECTION_LIMIT}, pool_timeout=${PRISMA_POOL_TIMEOUT}s)`,
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Prisma disconnected from database');
  }
}
