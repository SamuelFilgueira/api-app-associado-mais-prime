import {
  clampInt,
  sanitizeVersionString,
  CLAMP,
} from '../utils/analytics-sanitizer.util';

describe('analytics-sanitizer.util', () => {
  describe('clampInt', () => {
    it('retorna valor dentro do range sem alteração', () => {
      expect(clampInt(100, 0, 9999)).toBe(100);
    });

    it('clamp acima do máximo', () => {
      expect(clampInt(99999, 0, 9999)).toBe(9999);
    });

    it('clamp abaixo do mínimo', () => {
      expect(clampInt(-5, 0, 9999)).toBe(0);
    });

    it('converte string numérica', () => {
      expect(clampInt('500', 0, 9999)).toBe(500);
    });

    it('retorna min para NaN', () => {
      expect(clampInt('abc', 0, 9999)).toBe(0);
    });

    it('trunca valores fracionários', () => {
      expect(clampInt(9.9, 0, 9999)).toBe(9);
    });
  });

  describe('sanitizeVersionString', () => {
    it('faz trim de espaços', () => {
      expect(sanitizeVersionString('  1.0.0  ')).toBe('1.0.0');
    });

    it('trunca no limite máximo', () => {
      expect(sanitizeVersionString('1'.repeat(30), 20)).toHaveLength(20);
    });

    it('retorna undefined para não-string', () => {
      expect(sanitizeVersionString(123)).toBeUndefined();
      expect(sanitizeVersionString(null)).toBeUndefined();
    });
  });

  describe('CLAMP constants', () => {
    it('VIEW_COUNT max é 9999', () => {
      expect(CLAMP.VIEW_COUNT.max).toBe(9999);
    });

    it('TOTAL_TIME_MS max é 3600000', () => {
      expect(CLAMP.TOTAL_TIME_MS.max).toBe(3_600_000);
    });
  });
});
