import { carregarAppConfig, papelAtivo } from 'src/config/app.config';

describe('app.config', () => {
  it('sem envs: processo único, texto em dev, Swagger ligado, trust proxy só para rede interna', () => {
    const config = carregarAppConfig({});

    expect(config.role).toBe('all');
    expect(config.port).toBe(3001);
    expect(config.log).toEqual({
      formato: 'text',
      nivel: 'debug',
      redigirPii: true,
    });
    expect(config.http.swaggerHabilitado).toBe(true);
    expect(config.http.corsOrigins).toBeNull();
    expect(config.http.trustProxy).toBe('loopback, linklocal, uniquelocal');
    expect(config.http.limiteCorpoPadrao).toBe('1mb');
    expect(config.rateLimit).toEqual({ habilitado: true, aplicarTudo: false });
  });

  it('produção: log JSON e Swagger desligado até pedirem', () => {
    const config = carregarAppConfig({ NODE_ENV: 'production' });

    expect(config.emProducao).toBe(true);
    expect(config.log.formato).toBe('json');
    expect(config.log.nivel).toBe('log');
    expect(config.http.swaggerHabilitado).toBe(false);
    expect(
      carregarAppConfig({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })
        .http.swaggerHabilitado,
    ).toBe(true);
  });

  it('APP_ROLE inválido derruba o boot em vez de subir no papel errado', () => {
    expect(() => carregarAppConfig({ APP_ROLE: 'workers' })).toThrow(
      /APP_ROLE inválido/,
    );
    expect(carregarAppConfig({ APP_ROLE: ' Worker ' }).role).toBe('worker');
  });

  it('papelAtivo: `all` exerce todos; os demais só o próprio', () => {
    expect(papelAtivo('worker', 'all')).toBe(true);
    expect(papelAtivo('pdf', 'all')).toBe(true);
    expect(papelAtivo('worker', 'api')).toBe(false);
    expect(papelAtivo('api', 'api')).toBe(true);
    expect(papelAtivo('pdf', 'worker')).toBe(false);
  });

  it('TRUST_PROXY aceita número, false e lista de faixas', () => {
    expect(carregarAppConfig({ TRUST_PROXY: '1' }).http.trustProxy).toBe(1);
    expect(carregarAppConfig({ TRUST_PROXY: 'false' }).http.trustProxy).toBe(
      false,
    );
    expect(
      carregarAppConfig({ TRUST_PROXY: '10.0.0.0/8' }).http.trustProxy,
    ).toBe('10.0.0.0/8');
  });

  it('CORS_ORIGINS vira lista sem barra final; vazio mantém aberto', () => {
    expect(
      carregarAppConfig({
        CORS_ORIGINS: 'https://painel.exemplo.com/, https://outro.exemplo.com',
      }).http.corsOrigins,
    ).toEqual(['https://painel.exemplo.com', 'https://outro.exemplo.com']);
    expect(
      carregarAppConfig({ CORS_ORIGINS: ' , ' }).http.corsOrigins,
    ).toBeNull();
  });

  it('valores numéricos fora da faixa são contidos', () => {
    expect(carregarAppConfig({ PDF_CONCORRENCIA: '50' }).pdf.concorrencia).toBe(
      8,
    );
    expect(
      carregarAppConfig({ PDF_CONCORRENCIA: 'abc' }).pdf.concorrencia,
    ).toBe(2);
  });
});
