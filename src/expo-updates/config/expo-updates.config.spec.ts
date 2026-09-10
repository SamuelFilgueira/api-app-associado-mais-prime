import { carregarExpoUpdatesConfig } from './expo-updates.config';

describe('carregarExpoUpdatesConfig', () => {
  const envOriginal = { ...process.env };

  beforeEach(() => {
    delete process.env.EXPO_UPDATES_PUBLIC_URL;
    delete process.env.EXPO_UPDATES_PRIVATE_KEY_PATH;
    delete process.env.EXPO_UPDATES_PRIVATE_KEY_BASE64;
    delete process.env.EXPO_UPDATES_KEY_ID;
    delete process.env.APP_URL;
  });

  afterAll(() => {
    process.env = envOriginal;
  });

  it('usa EXPO_UPDATES_PUBLIC_URL sem barra final quando definida', () => {
    process.env.EXPO_UPDATES_PUBLIC_URL = 'https://api.exemplo.com.br/';
    process.env.APP_URL = 'http://localhost:3001';
    expect(carregarExpoUpdatesConfig().urlPublica).toBe(
      'https://api.exemplo.com.br',
    );
  });

  it('cai para APP_URL quando EXPO_UPDATES_PUBLIC_URL está ausente', () => {
    process.env.APP_URL = 'https://app.exemplo.com.br';
    expect(carregarExpoUpdatesConfig().urlPublica).toBe(
      'https://app.exemplo.com.br',
    );
  });

  it('"auto" ignora APP_URL e deixa a URL para o host da requisição', () => {
    process.env.EXPO_UPDATES_PUBLIC_URL = 'AUTO';
    process.env.APP_URL = 'http://localhost:3001';
    expect(carregarExpoUpdatesConfig().urlPublica).toBeNull();
  });

  it('aceita a chave privada em base64 e keyId customizado', () => {
    process.env.EXPO_UPDATES_PRIVATE_KEY_BASE64 = Buffer.from(
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    ).toString('base64');
    process.env.EXPO_UPDATES_KEY_ID = 'prod';
    const cfg = carregarExpoUpdatesConfig();
    expect(cfg.chavePrivadaPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(cfg.keyId).toBe('prod');
  });
});
