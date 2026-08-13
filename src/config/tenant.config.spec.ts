import {
  isTenantBase,
  mapTenantBases,
  resetTenantConfigCache,
  TENANT,
  tenantEnvName,
} from './tenant.config';

/**
 * Variáveis de tenant que precisam ser limpas entre os testes para que
 * cada cenário monte a config do zero.
 */
const TENANT_ENV_KEYS = [
  'TENANT_BASES',
  'TENANT_DEFAULT_BASE',
  'TENANT_REQUIRED_INTEGRATIONS',
  'TENANT_NAME',
  'TENANT_APP_NAME',
  'TENANT_REPORT_NAME',
  'TENANT_LOGO_PATH',
  'TENANT_DOCUMENTS_BASE_URL',
  'MAIL_TO_PREVIA',
  'MAIL_TO_COBRANCA',
  'APP_URL',
];

describe('tenant.config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of TENANT_ENV_KEYS) {
      delete process.env[key];
    }
    resetTenantConfigCache();
  });

  afterAll(() => {
    process.env = originalEnv;
    resetTenantConfigCache();
  });

  describe('compatibilidade com o deploy atual (Mais Prime)', () => {
    it('usa MAIS_PRIME e MAIS_PRIME_RS quando TENANT_BASES não está definido', () => {
      expect(TENANT.baseNames).toEqual(['MAIS_PRIME', 'MAIS_PRIME_RS']);
      expect(TENANT.defaultBase).toBe('MAIS_PRIME');
    });

    it('reproduz exatamente os nomes de env do mapa literal anterior', () => {
      // Base principal — envs sem sufixo
      expect(tenantEnvName('MAIS_PRIME', 'sgaUser')).toBe(
        'USER_SGA_MAIS_PRIME',
      );
      expect(tenantEnvName('MAIS_PRIME', 'sgaPassword')).toBe(
        'PASSWORD_SGA_MAIS_PRIME',
      );
      expect(tenantEnvName('MAIS_PRIME', 'sgaBaseToken')).toBe(
        'TOKEN_BASE_SGA_MAIS_PRIME',
      );
      expect(tenantEnvName('MAIS_PRIME', 'logica')).toBe('LOGICA_TOKEN');
      expect(tenantEnvName('MAIS_PRIME', 'softruck')).toBe('SOFTRUCK_TOKEN');
      expect(tenantEnvName('MAIS_PRIME', 'softruckUsername')).toBe(
        'USERNAME_SOFTRUCK',
      );
      expect(tenantEnvName('MAIS_PRIME', 'softruckPassword')).toBe(
        'PASSWORD_SOFTRUCK',
      );
      expect(tenantEnvName('MAIS_PRIME', 'softruckPublicKey')).toBe(
        'PUBLIC_KEY_SOFTRUCK',
      );
      expect(tenantEnvName('MAIS_PRIME', 'clubgas')).toBe('TOKEN_API_CLUBGAS');
      expect(tenantEnvName('MAIS_PRIME', 'm7Token')).toBe('MO7_TOKEN');
      expect(tenantEnvName('MAIS_PRIME', 'm7Codigo')).toBe('M07_CODIGO');
      expect(tenantEnvName('MAIS_PRIME', 'apiSecretAlloyal')).toBe(
        'API_SECRET_ALLOYAL',
      );
      expect(tenantEnvName('MAIS_PRIME', 'alloyalBusinessId')).toBe(
        'ALLOYAL_BUSINESS_ID',
      );
      expect(tenantEnvName('MAIS_PRIME', 'alloyalBusinessCnpj')).toBe(
        'ALLOYAL_BUSINESS_CNPJ',
      );

      // Base RS — envs com sufixo _RS, exceto SGA que usa o nome da base
      expect(tenantEnvName('MAIS_PRIME_RS', 'sgaUser')).toBe(
        'USER_SGA_MAIS_PRIME_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'sgaPassword')).toBe(
        'PASSWORD_SGA_MAIS_PRIME_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'sgaBaseToken')).toBe(
        'TOKEN_BASE_SGA_MAIS_PRIME_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'logica')).toBe('LOGICA_TOKEN_RS');
      expect(tenantEnvName('MAIS_PRIME_RS', 'softruck')).toBe(
        'SOFTRUCK_TOKEN_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'softruckUsername')).toBe(
        'USERNAME_SOFTRUCK_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'softruckPassword')).toBe(
        'PASSWORD_SOFTRUCK_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'softruckPublicKey')).toBe(
        'PUBLIC_KEY_SOFTRUCK_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'clubgas')).toBe(
        'TOKEN_API_CLUBGAS_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'm7Token')).toBe('MO7_TOKEN_RS');
      expect(tenantEnvName('MAIS_PRIME_RS', 'm7Codigo')).toBe('M07_CODIGO_RS');
      expect(tenantEnvName('MAIS_PRIME_RS', 'apiSecretAlloyal')).toBe(
        'API_SECRET_ALLOYAL_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'alloyalBusinessId')).toBe(
        'ALLOYAL_BUSINESS_ID_RS',
      );
      expect(tenantEnvName('MAIS_PRIME_RS', 'alloyalBusinessCnpj')).toBe(
        'ALLOYAL_BUSINESS_CNPJ_RS',
      );
    });

    it('mantém a marca atual em e-mails e relatórios', () => {
      expect(TENANT.name).toBe('Mais Prime');
      expect(TENANT.appName).toBe('Mais Prime App');
      expect(TENANT.reportName).toBe('Mais Prime');
      expect(TENANT.mailPrevia).toBe('previa@maisprime.org.br');
      expect(TENANT.mailCobranca).toBe('cobranca@maisprime.org.br');
      expect(TENANT.documentsBaseUrl).toBe('https://app-dev.texvngroup.com.br');
    });
  });

  describe('deploy de base única (Hertz)', () => {
    beforeEach(() => {
      process.env.TENANT_BASES = 'HERTZ';
      process.env.TENANT_NAME = 'Hertz';
      process.env.MAIL_TO_PREVIA = 'previa@hertz.com.br';
      process.env.MAIL_TO_COBRANCA = 'cobranca@hertz.com.br';
      process.env.APP_URL = 'https://api.hertz.com.br';
      resetTenantConfigCache();
    });

    it('expõe uma única base, usada como padrão', () => {
      expect(TENANT.baseNames).toEqual(['HERTZ']);
      expect(TENANT.defaultBase).toBe('HERTZ');
    });

    it('deriva envs sem sufixo para a base única', () => {
      expect(tenantEnvName('HERTZ', 'sgaUser')).toBe('USER_SGA_HERTZ');
      expect(tenantEnvName('HERTZ', 'logica')).toBe('LOGICA_TOKEN');
      expect(tenantEnvName('HERTZ', 'm7Token')).toBe('MO7_TOKEN');
    });

    it('aplica a marca da nova empresa', () => {
      expect(TENANT.name).toBe('Hertz');
      expect(TENANT.appName).toBe('Hertz App');
      expect(TENANT.mailPrevia).toBe('previa@hertz.com.br');
      expect(TENANT.documentsBaseUrl).toBe('https://api.hertz.com.br');
    });

    it('rejeita bases de outra empresa', () => {
      expect(isTenantBase('HERTZ')).toBe(true);
      expect(isTenantBase('MAIS_PRIME')).toBe(false);
      expect(() => tenantEnvName('MAIS_PRIME', 'sgaUser')).toThrow(
        /Base de origem desconhecida/,
      );
    });

    it('mapTenantBases cria uma entrada por base configurada', () => {
      expect(mapTenantBases(() => null)).toEqual({ HERTZ: null });
    });
  });

  describe('deploy multi-base da nova empresa', () => {
    it('aceita sufixo explícito por base', () => {
      process.env.TENANT_BASES = 'HERTZ:,HERTZ_SP:_SP';
      resetTenantConfigCache();

      expect(TENANT.baseNames).toEqual(['HERTZ', 'HERTZ_SP']);
      expect(tenantEnvName('HERTZ', 'm7Token')).toBe('MO7_TOKEN');
      expect(tenantEnvName('HERTZ_SP', 'm7Token')).toBe('MO7_TOKEN_SP');
      expect(tenantEnvName('HERTZ_SP', 'sgaUser')).toBe('USER_SGA_HERTZ_SP');
    });

    it('usa o nome da base como sufixo quando não informado', () => {
      process.env.TENANT_BASES = 'HERTZ,HERTZ_SP';
      resetTenantConfigCache();

      expect(tenantEnvName('HERTZ', 'm7Token')).toBe('MO7_TOKEN');
      expect(tenantEnvName('HERTZ_SP', 'm7Token')).toBe('MO7_TOKEN_HERTZ_SP');
    });

    it('permite escolher explicitamente a base padrão', () => {
      process.env.TENANT_BASES = 'HERTZ:,HERTZ_SP:_SP';
      process.env.TENANT_DEFAULT_BASE = 'HERTZ_SP';
      resetTenantConfigCache();

      expect(TENANT.defaultBase).toBe('HERTZ_SP');
    });
  });

  describe('validação de configuração', () => {
    it('falha se TENANT_DEFAULT_BASE não estiver em TENANT_BASES', () => {
      process.env.TENANT_BASES = 'HERTZ';
      process.env.TENANT_DEFAULT_BASE = 'MAIS_PRIME';
      resetTenantConfigCache();

      expect(() => TENANT.defaultBase).toThrow(/não está em TENANT_BASES/);
    });

    it('falha em bases duplicadas', () => {
      process.env.TENANT_BASES = 'HERTZ,HERTZ';
      resetTenantConfigCache();

      expect(() => TENANT.baseNames).toThrow(/duplicadas/);
    });

    it('falha se TENANT_BASES estiver vazio', () => {
      process.env.TENANT_BASES = '   ';
      resetTenantConfigCache();

      expect(() => TENANT.baseNames).toThrow(/TENANT_BASES está vazio/);
    });

    it('falha em integração obrigatória desconhecida', () => {
      process.env.TENANT_REQUIRED_INTEGRATIONS = 'sga,inexistente';
      resetTenantConfigCache();

      expect(() => TENANT.requiredIntegrations).toThrow(/desconhecida/);
    });

    it('expande o atalho "sga" nas três credenciais do SGA', () => {
      process.env.TENANT_REQUIRED_INTEGRATIONS = 'sga';
      resetTenantConfigCache();

      expect(TENANT.requiredIntegrations).toEqual([
        'sgaUser',
        'sgaPassword',
        'sgaBaseToken',
      ]);
    });
  });
});
