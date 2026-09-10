import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { ANALYTICS_QUEUE } from 'src/queue/queue.module';
import {
  AnalyticsJourneyDevicesQueryDto,
  AnalyticsJourneyQueryDto,
} from 'src/analytics/dto/analytics-journey-query.dto';
import {
  JOURNEY_ACTIVE_DEVICE_WINDOW_DAYS,
  JOURNEY_CLEANUP_JOB,
  JOURNEY_CLEANUP_SCHEDULER_ID,
} from 'src/analytics/constants/analytics-journey.constants';

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 92;
const DEFAULT_PAGE = 200;
/** Teto de eventos lidos para montar sessões (agrupamento em memória). */
const SESSIONS_EVENT_CAP = 5000;
const MAX_SESSIONS = 100;

export type JourneyDeviceStatus = 'ATIVO' | 'DESLOGADO' | 'INATIVO';

const BRT_FORMATTER = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** "27/08/2026 14:22:58" no fuso de São Paulo — para leitura humana. */
function toBrt(date: Date | null | undefined): string | null {
  return date ? BRT_FORMATTER.format(date) : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

type DeviceRow = Prisma.AnalyticsDeviceGetPayload<object>;

/**
 * Consultas da jornada do usuário (somente leitura, endpoints admin) e
 * agendamento da limpeza por TTL.
 *
 * Todas as leituras batem em índices (userId+occurredAt, installHash+occurredAt,
 * name+occurredAt) e são paginadas por cursor — nunca varrem a tabela inteira.
 */
@Injectable()
export class AnalyticsJourneyService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsJourneyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ANALYTICS_QUEUE) private readonly analyticsQueue: Queue,
  ) {}

  /**
   * Registra (ou remove) o job repetível de limpeza na fila de analytics.
   * Roda 03:30 (America/Sao_Paulo) quando ANALYTICS_JOURNEY_ENABLED=true.
   * Falha aqui não derruba o boot — só loga.
   */
  async onModuleInit(): Promise<void> {
    const enabled = isTruthyEnv(process.env.ANALYTICS_JOURNEY_ENABLED);
    try {
      if (enabled) {
        await this.analyticsQueue.upsertJobScheduler(
          JOURNEY_CLEANUP_SCHEDULER_ID,
          { pattern: '30 3 * * *', tz: 'America/Sao_Paulo' },
          {
            name: JOURNEY_CLEANUP_JOB,
            opts: { removeOnComplete: true, removeOnFail: 20 },
          },
        );
        this.logger.log(
          'Jornada do usuário ATIVA (ANALYTICS_JOURNEY_ENABLED=true) — limpeza diária agendada às 03:30',
        );
      } else {
        await this.analyticsQueue.removeJobScheduler(
          JOURNEY_CLEANUP_SCHEDULER_ID,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Não foi possível configurar a limpeza da jornada: ${(err as Error).message}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APARELHOS DE UMA CONTA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * "Em quantos celulares a conta está logada?" — lista todos os aparelhos que
   * já enviaram summary autenticado com este userId, com modelo/SO e status:
   *  - ATIVO: visto dentro da janela e sem logout posterior ao último uso;
   *  - DESLOGADO: último evento de logout é posterior ao último uso autenticado;
   *  - INATIVO: sem summary autenticado dentro da janela.
   */
  async getUserDevices(userId: number, query: AnalyticsJourneyDevicesQueryDto) {
    const user = await this.findUserOrThrow(userId);
    const activeDays = query.active_days ?? JOURNEY_ACTIVE_DEVICE_WINDOW_DAYS;
    const activeSince = new Date(Date.now() - activeDays * 24 * 60 * 60 * 1000);

    const links = await this.prisma.analyticsUserDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });

    if (links.length === 0) {
      return {
        user,
        activeWindowDays: activeDays,
        activeDevicesCount: 0,
        devices: [],
      };
    }

    const hashes = links.map((l) => l.installHash);
    const [devices, otherUsers] = await Promise.all([
      this.prisma.analyticsDevice.findMany({
        where: { installHash: { in: hashes } },
      }),
      // Outras contas vistas nos mesmos aparelhos (celular compartilhado?)
      this.prisma.analyticsUserDevice.groupBy({
        by: ['installHash'],
        where: { installHash: { in: hashes }, userId: { not: userId } },
        _count: { userId: true },
      }),
    ]);

    const deviceByHash = new Map(devices.map((d) => [d.installHash, d]));
    const othersByHash = new Map(
      otherUsers.map((o) => [o.installHash, o._count.userId]),
    );

    const result = links.map((link) => {
      const status = this.resolveStatus(
        link.lastSeenAt,
        link.lastLogoutAt,
        activeSince,
      );
      return {
        ...this.presentDevice(
          deviceByHash.get(link.installHash) ?? null,
          link.installHash,
        ),
        status,
        firstSeenAt: link.firstSeenAt,
        firstSeenAtBrt: toBrt(link.firstSeenAt),
        lastSeenAt: link.lastSeenAt,
        lastSeenAtBrt: toBrt(link.lastSeenAt),
        lastLoginAt: link.lastLoginAt,
        lastLoginAtBrt: toBrt(link.lastLoginAt),
        lastLogoutAt: link.lastLogoutAt,
        lastLogoutAtBrt: toBrt(link.lastLogoutAt),
        lastAppVersion: link.lastAppVersion,
        summariesCount: link.summariesCount,
        otherAccountsOnDevice: othersByHash.get(link.installHash) ?? 0,
      };
    });

    return {
      user,
      activeWindowDays: activeDays,
      activeDevicesCount: result.filter((d) => d.status === 'ATIVO').length,
      devices: result,
    };
  }

  /** Um aparelho e todas as contas que já o usaram. */
  async getDevice(installHash: string) {
    const device = await this.findDeviceByHashOrPrefix(installHash);
    const links = await this.prisma.analyticsUserDevice.findMany({
      where: { installHash: device.installHash },
      orderBy: { lastSeenAt: 'desc' },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: links.map((l) => l.userId) } },
      select: { id: true, name: true, baseOrigin: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const activeSince = new Date(
      Date.now() - JOURNEY_ACTIVE_DEVICE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    return {
      device: {
        ...this.presentDevice(device, device.installHash),
        lastUserId: device.lastUserId,
        lastIp: device.lastIp,
        summariesCount: device.summariesCount,
        firstSeenAt: device.firstSeenAt,
        firstSeenAtBrt: toBrt(device.firstSeenAt),
        lastSeenAt: device.lastSeenAt,
        lastSeenAtBrt: toBrt(device.lastSeenAt),
      },
      accounts: links.map((link) => ({
        user: userById.get(link.userId) ?? { id: link.userId, name: null },
        status: this.resolveStatus(
          link.lastSeenAt,
          link.lastLogoutAt,
          activeSince,
        ),
        firstSeenAt: link.firstSeenAt,
        firstSeenAtBrt: toBrt(link.firstSeenAt),
        lastSeenAt: link.lastSeenAt,
        lastSeenAtBrt: toBrt(link.lastSeenAt),
        lastLoginAt: link.lastLoginAt,
        lastLogoutAt: link.lastLogoutAt,
        summariesCount: link.summariesCount,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LINHA DO TEMPO
  // ─────────────────────────────────────────────────────────────────────────

  /** Eventos de uma conta em ordem cronológica, paginados por cursor. */
  async getUserEvents(userId: number, query: AnalyticsJourneyQueryDto) {
    const user = await this.findUserOrThrow(userId);
    const page = await this.queryEvents({ userId }, query);
    return { user, ...page };
  }

  /** Eventos de um aparelho (com ou sem conta), paginados por cursor. */
  async getDeviceEvents(installHash: string, query: AnalyticsJourneyQueryDto) {
    const device = await this.findDeviceByHashOrPrefix(installHash);
    const page = await this.queryEvents(
      { installHash: device.installHash },
      { ...query, install: undefined },
    );
    return {
      device: this.presentDevice(device, device.installHash),
      ...page,
    };
  }

  /**
   * Eventos das contas vinculadas a um veículo (chassi ou placa). Responde
   * "quem abriu a tela de rastreamento da placa X às 19:43".
   */
  async getVehicleEvents(identifier: string, query: AnalyticsJourneyQueryDto) {
    const needle = identifier.trim().toUpperCase();
    const vehicles = await this.prisma.userVehicle.findMany({
      where: { OR: [{ chassi: needle }, { plate: needle }] },
      select: {
        userId: true,
        chassi: true,
        plate: true,
        isActive: true,
        user: { select: { id: true, name: true } },
      },
    });
    if (vehicles.length === 0) {
      throw new NotFoundException('Veículo não encontrado em UserVehicle');
    }

    const userIds = [...new Set(vehicles.map((v) => v.userId))];
    const page = await this.queryEvents({ userId: { in: userIds } }, query);

    return {
      vehicle: { chassi: vehicles[0].chassi, plate: vehicles[0].plate },
      accounts: vehicles.map((v) => ({ ...v.user, isActive: v.isActive })),
      ...page,
    };
  }

  /**
   * Sessões de uma conta: eventos agrupados por sessionHash, com o caminho
   * completo (tela → ação → tela…) em ordem. Lê no máximo SESSIONS_EVENT_CAP
   * eventos do intervalo — para históricos maiores, reduza `from`/`to`.
   */
  async getUserSessions(userId: number, query: AnalyticsJourneyQueryDto) {
    const user = await this.findUserOrThrow(userId);
    const { from, to } = this.resolveRange(query);

    const events = await this.prisma.analyticsJourneyEvent.findMany({
      where: {
        userId,
        occurredAt: { gte: from, lte: to },
        ...(query.install
          ? { installHash: this.installWhere(query.install) }
          : {}),
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: SESSIONS_EVENT_CAP,
    });

    const sessions = new Map<
      string,
      {
        sessionHash: string;
        installHash: string;
        platform: string;
        appVersion: string;
        startedAt: Date;
        endedAt: Date;
        path: ReturnType<AnalyticsJourneyService['presentEvent']>[];
      }
    >();

    for (const e of events) {
      const current = sessions.get(e.sessionHash);
      const presented = this.presentEvent(e);
      if (!current) {
        sessions.set(e.sessionHash, {
          sessionHash: e.sessionHash,
          installHash: e.installHash,
          platform: e.platform,
          appVersion: e.appVersion,
          startedAt: e.occurredAt,
          endedAt: e.occurredAt,
          path: [presented],
        });
      } else {
        current.endedAt = e.occurredAt;
        current.path.push(presented);
      }
    }

    const deviceMap = await this.loadDevices(
      [...sessions.values()].map((s) => s.installHash),
    );

    const list = [...sessions.values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, MAX_SESSIONS)
      .map((s) => ({
        sessionHash: s.sessionHash,
        device: this.presentDevice(
          deviceMap.get(s.installHash) ?? null,
          s.installHash,
        ),
        platform: s.platform,
        appVersion: s.appVersion,
        startedAt: s.startedAt,
        startedAtBrt: toBrt(s.startedAt),
        endedAt: s.endedAt,
        endedAtBrt: toBrt(s.endedAt),
        durationMs: s.endedAt.getTime() - s.startedAt.getTime(),
        eventsCount: s.path.length,
        screensCount: s.path.filter((p) => p.type === 'SCREEN').length,
        path: s.path,
      }));

    return {
      user,
      from,
      to,
      truncated: events.length >= SESSIONS_EVENT_CAP,
      sessionsCount: list.length,
      sessions: list,
    };
  }

  /**
   * Quem viu uma tela (ou executou uma ação) no intervalo — agrupado por
   * conta, com contagem e último horário. Base para investigações do tipo
   * "quem abriu screen_rastreamento entre 19:40 e 19:50".
   */
  async getEventViewers(name: string, query: AnalyticsJourneyQueryDto) {
    const { from, to } = this.resolveRange(query);
    const limit = query.limit ?? DEFAULT_PAGE;

    const grouped = await this.prisma.analyticsJourneyEvent.groupBy({
      by: ['userId', 'installHash'],
      where: { name, occurredAt: { gte: from, lte: to } },
      _count: { id: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: 'desc' } },
      take: limit,
    });

    const userIds = [
      ...new Set(
        grouped.map((g) => g.userId).filter((id): id is number => id !== null),
      ),
    ];
    const [users, deviceMap] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      }),
      this.loadDevices(grouped.map((g) => g.installHash)),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      event: name,
      from,
      to,
      viewers: grouped.map((g) => ({
        user:
          g.userId === null
            ? null
            : (userById.get(g.userId) ?? { id: g.userId, name: null }),
        device: this.presentDevice(
          deviceMap.get(g.installHash) ?? null,
          g.installHash,
        ),
        count: g._count.id,
        firstAt: g._min.occurredAt,
        firstAtBrt: toBrt(g._min.occurredAt),
        lastAt: g._max.occurredAt,
        lastAtBrt: toBrt(g._max.occurredAt),
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTERNOS
  // ─────────────────────────────────────────────────────────────────────────

  private async queryEvents(
    baseWhere: Prisma.AnalyticsJourneyEventWhereInput,
    query: AnalyticsJourneyQueryDto,
  ) {
    const { from, to } = this.resolveRange(query);
    const limit = query.limit ?? DEFAULT_PAGE;

    const where: Prisma.AnalyticsJourneyEventWhereInput = {
      ...baseWhere,
      occurredAt: { gte: from, lte: to },
      ...(query.install
        ? { installHash: this.installWhere(query.install) }
        : {}),
      ...(query.event ? { name: query.event } : {}),
      ...(query.cursor ? { id: { gt: BigInt(query.cursor) } } : {}),
    };

    const rows = await this.prisma.analyticsJourneyEvent.findMany({
      where,
      // id cresce com a ordem de inserção; dentro do mesmo summary os eventos
      // já foram ordenados por horário antes de gravar (seq).
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const deviceMap = await this.loadDevices(
      pageRows.map((r) => r.installHash),
    );

    return {
      from,
      to,
      count: pageRows.length,
      nextCursor: hasMore ? Number(pageRows[pageRows.length - 1].id) : null,
      items: pageRows.map((r) => ({
        ...this.presentEvent(r),
        userId: r.userId,
        sessionHash: r.sessionHash,
        device: this.presentDevice(
          deviceMap.get(r.installHash) ?? null,
          r.installHash,
        ),
        appVersion: r.appVersion,
      })),
    };
  }

  private presentEvent(e: Prisma.AnalyticsJourneyEventGetPayload<object>) {
    return {
      id: Number(e.id),
      occurredAt: e.occurredAt,
      occurredAtBrt: toBrt(e.occurredAt),
      type: e.eventType,
      name: e.name,
      screen: e.screen,
      outcome: e.outcome,
      durationMs: e.durationMs,
      receiptId: e.receiptId,
    };
  }

  private presentDevice(device: DeviceRow | null, installHash: string) {
    return {
      installHash,
      installHashShort: installHash.slice(0, 8),
      platform: device?.platform ?? null,
      brand: device?.brand ?? null,
      model: device?.model ?? null,
      modelId: device?.modelId ?? null,
      osName: device?.osName ?? null,
      osVersion: device?.osVersion ?? null,
      deviceType: device?.deviceType ?? null,
      timezone: device?.timezone ?? null,
      appVersion: device?.appVersion ?? null,
      /** Rótulo pronto para exibição: "Samsung SM-A155M · Android 14". */
      label: device
        ? [
            [device.brand, device.model].filter(Boolean).join(' ') || null,
            [device.osName, device.osVersion].filter(Boolean).join(' ') || null,
          ]
            .filter(Boolean)
            .join(' · ') || `${device.platform} (modelo não informado)`
        : 'aparelho sem registro de device',
    };
  }

  private resolveStatus(
    lastSeenAt: Date,
    lastLogoutAt: Date | null,
    activeSince: Date,
  ): JourneyDeviceStatus {
    if (lastLogoutAt && lastLogoutAt >= lastSeenAt) return 'DESLOGADO';
    if (lastSeenAt < activeSince) return 'INATIVO';
    return 'ATIVO';
  }

  private resolveRange(query: AnalyticsJourneyQueryDto): {
    from: Date;
    to: Date;
  } {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new UnprocessableEntityException('Datas inválidas');
    }
    if (from > to) {
      throw new UnprocessableEntityException('"from" deve ser anterior a "to"');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException(
        `Intervalo máximo de consulta é ${MAX_RANGE_DAYS} dias`,
      );
    }
    return { from, to };
  }

  private installWhere(install: string): Prisma.StringFilter {
    const value = install.trim().toLowerCase();
    if (value.length < 8) {
      throw new UnprocessableEntityException(
        'install precisa ter ao menos 8 caracteres',
      );
    }
    return value.length === 64 ? { equals: value } : { startsWith: value };
  }

  private async findDeviceByHashOrPrefix(
    installHash: string,
  ): Promise<DeviceRow> {
    const devices = await this.prisma.analyticsDevice.findMany({
      where: { installHash: this.installWhere(installHash) },
      take: 2,
    });
    if (devices.length === 0) {
      throw new NotFoundException('Aparelho não encontrado');
    }
    if (devices.length > 1) {
      throw new UnprocessableEntityException(
        'Prefixo ambíguo — informe mais caracteres do installHash',
      );
    }
    return devices[0];
  }

  private async loadDevices(hashes: string[]): Promise<Map<string, DeviceRow>> {
    const unique = [...new Set(hashes)];
    if (unique.length === 0) return new Map();
    const devices = await this.prisma.analyticsDevice.findMany({
      where: { installHash: { in: unique } },
    });
    return new Map(devices.map((d) => [d.installHash, d]));
  }

  private async findUserOrThrow(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, baseOrigin: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return user;
  }
}
