import { scanForProhibitedKeys } from '../utils/prohibited-key-scanner.util';

describe('prohibited-key-scanner.util', () => {
  it('retorna array vazio para payload sem chaves proibidas', () => {
    const payload = {
      period_start: '2024-01-01T00:00:00Z',
      period_end: '2024-01-01T00:30:00Z',
      app: { platform: 'android', version: '1.0.0' },
      session: { session_id: 'uuid', anonymous_install_id: 'uuid' },
      screens: [{ screen: 'screen_home', view_count: 1, total_time_ms: 1000 }],
      actions: [{ action: 'auth_login_success', count: 1 }],
    };
    expect(scanForProhibitedKeys(payload)).toHaveLength(0);
  });

  it('detecta userId em camelCase', () => {
    const payload = { userId: 123, screen: 'screen_home' };
    const result = scanForProhibitedKeys(payload);
    expect(result).toContain('userId');
  });

  it('detecta user_id em snake_case', () => {
    const payload = { user_id: 123 };
    const result = scanForProhibitedKeys(payload);
    expect(result).toContain('user_id');
  });

  it('detecta cpf', () => {
    const payload = { cpf: '000.000.000-00' };
    expect(scanForProhibitedKeys(payload)).toContain('cpf');
  });

  it('detecta chave proibida aninhada dentro de array', () => {
    const payload = {
      screens: [{ screen: 'screen_home', email: 'test@test.com' }],
    };
    const result = scanForProhibitedKeys(payload);
    expect(result.some((p) => p.includes('email'))).toBe(true);
  });

  it('detecta chave proibida aninhada em objeto', () => {
    const payload = { session: { anonymous_install_id: 'uuid', lat: -23.0 } };
    const result = scanForProhibitedKeys(payload);
    expect(result.some((p) => p.includes('lat'))).toBe(true);
  });

  it('detecta token', () => {
    const payload = { token: 'Bearer xyz' };
    expect(scanForProhibitedKeys(payload)).toContain('token');
  });

  it('ignora valores primitivos que não são objetos', () => {
    expect(scanForProhibitedKeys('string')).toHaveLength(0);
    expect(scanForProhibitedKeys(42)).toHaveLength(0);
    expect(scanForProhibitedKeys(null)).toHaveLength(0);
  });
});
