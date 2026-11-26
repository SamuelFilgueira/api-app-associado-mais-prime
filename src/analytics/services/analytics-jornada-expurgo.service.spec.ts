import { Logger } from '@nestjs/common';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';
import { PrismaService } from 'src/database/prisma.service';

describe('AnalyticsJornadaExpurgoService — expurgarJornada()', () => {
  const prisma = { $executeRaw: jest.fn() };
  const ttlOriginal = process.env.ANALYTICS_JOURNEY_TTL_DAYS;
  const agora = new Date('2026-11-25T12:00:00.000Z');
  let service: AnalyticsJornadaExpurgoService;
  let log: jest.SpyInstance;

  /** Parâmetros do `DELETE` da chamada `n` (template literal etiquetado). */
  const parametros = (n: number) =>
    (prisma.$executeRaw.mock.calls[n] as unknown[]).slice(1);
  const sql = (n: number) =>
    (prisma.$executeRaw.mock.calls[n][0] as string[]).join('?');

  beforeEach(() => {
    jest.clearAllMocks();
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    delete process.env.ANALYTICS_JOURNEY_TTL_DAYS;
    service = new AnalyticsJornadaExpurgoService(
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    if (ttlOriginal === undefined)
      delete process.env.ANALYTICS_JOURNEY_TTL_DAYS;
    else process.env.ANALYTICS_JOURNEY_TTL_DAYS = ttlOriginal;
    jest.restoreAllMocks();
  });

  it('apaga em lotes de 5000 até vir um lote incompleto', async () => {
    prisma.$executeRaw
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(120);

    await expect(service.expurgarJornada(agora)).resolves.toEqual({
      removidos: 10_120,
      corte: new Date('2026-08-27T12:00:00.000Z'),
      ttlDias: 90,
      incompleto: false,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    expect(sql(0)).toMatch(
      /DELETE FROM `AnalyticsJourneyEvent`\s+WHERE `occurredAt` < \?\s+LIMIT \?/,
    );
    expect(parametros(0)).toEqual([new Date('2026-08-27T12:00:00.000Z'), 5000]);
  });

  it('nada a apagar: um comando só, sem log', async () => {
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(service.expurgarJornada(agora)).resolves.toMatchObject({
      removidos: 0,
      incompleto: false,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('respeita ANALYTICS_JOURNEY_TTL_DAYS', async () => {
    process.env.ANALYTICS_JOURNEY_TTL_DAYS = '30';
    prisma.$executeRaw.mockResolvedValue(0);

    const resultado = await service.expurgarJornada(agora);

    expect(resultado.ttlDias).toBe(30);
    expect(resultado.corte).toEqual(new Date('2026-10-26T12:00:00.000Z'));
  });

  it.each(['', 'abc', '0'])(
    'TTL inválido ou zero (%p) cai no padrão de 90 dias — nunca apaga tudo',
    async (valor) => {
      process.env.ANALYTICS_JOURNEY_TTL_DAYS = valor;
      prisma.$executeRaw.mockResolvedValue(0);

      expect((await service.expurgarJornada(agora)).ttlDias).toBe(90);
    },
  );

  it('para no teto de 200 lotes por rodada e avisa que ficou incompleto', async () => {
    prisma.$executeRaw.mockResolvedValue(5000);

    await expect(service.expurgarJornada(agora)).resolves.toMatchObject({
      removidos: 1_000_000,
      incompleto: true,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(200);
  });

  it('erro do banco propaga (o job falha e a fila decide)', async () => {
    prisma.$executeRaw.mockRejectedValue(new Error('Lock wait timeout'));

    await expect(service.expurgarJornada(agora)).rejects.toThrow(
      'Lock wait timeout',
    );
  });
});
