import {
  hmacSha256,
  sha256,
  canonicalPayloadHash,
} from '../utils/analytics-hash.util';

describe('analytics-hash.util', () => {
  const SECRET = 'test-secret-1234567890';

  describe('hmacSha256', () => {
    it('retorna string hex de 64 chars', () => {
      const result = hmacSha256('test-uuid', SECRET);
      expect(typeof result).toBe('string');
      expect(result).toHaveLength(64);
    });

    it('é determinístico para mesma entrada', () => {
      const a = hmacSha256('uuid-abc', SECRET);
      const b = hmacSha256('uuid-abc', SECRET);
      expect(a).toBe(b);
    });

    it('produz valores diferentes para entradas diferentes', () => {
      const a = hmacSha256('uuid-abc', SECRET);
      const b = hmacSha256('uuid-xyz', SECRET);
      expect(a).not.toBe(b);
    });

    it('nunca expõe o valor original no hash', () => {
      const installId = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
      const hash = hmacSha256(installId, SECRET);
      expect(hash).not.toContain(installId);
    });
  });

  describe('sha256', () => {
    it('retorna string hex de 64 chars', () => {
      expect(sha256('hello')).toHaveLength(64);
    });
  });

  describe('canonicalPayloadHash', () => {
    it('é estável independente da ordem das chaves', () => {
      const a = canonicalPayloadHash({ b: 2, a: 1 });
      const b = canonicalPayloadHash({ a: 1, b: 2 });
      expect(a).toBe(b);
    });
  });
});
