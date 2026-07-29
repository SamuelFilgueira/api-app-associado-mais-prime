import { saoPauloDay, saoPauloDayString } from './analytics-day.util';

describe('saoPauloDayString', () => {
  it('atribui 23h UTC (20h em SP) ao dia local, não ao dia UTC', () => {
    // 2026-07-15T23:30Z = 20:30 em São Paulo (UTC-3) → ainda dia 15
    expect(saoPauloDayString(new Date('2026-07-15T23:30:00.000Z'))).toBe(
      '2026-07-15',
    );
  });

  it('vira o dia às 03h UTC (meia-noite em SP)', () => {
    // 2026-07-16T02:59Z = 23:59 do dia 15 em SP
    expect(saoPauloDayString(new Date('2026-07-16T02:59:00.000Z'))).toBe(
      '2026-07-15',
    );
    // 2026-07-16T03:00Z = 00:00 do dia 16 em SP
    expect(saoPauloDayString(new Date('2026-07-16T03:00:00.000Z'))).toBe(
      '2026-07-16',
    );
  });

  it('mantém horários diurnos no mesmo dia', () => {
    expect(saoPauloDayString(new Date('2026-07-15T15:00:00.000Z'))).toBe(
      '2026-07-15',
    );
  });
});

describe('saoPauloDay', () => {
  it('ancora o DATE na meia-noite UTC do dia local', () => {
    const day = saoPauloDay(new Date('2026-07-15T23:30:00.000Z'));
    expect(day.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });
});
