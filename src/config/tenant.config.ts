/**
 * Configuração de tenant (multi-base) da aplicação.
 *
 * Fonte única de verdade sobre:
 *  - quais bases (`baseOrigin`) existem neste deploy;
 *  - como o nome de cada base vira nome de variável de ambiente;
 *  - identidade visual/textual da empresa (marca, e-mails, logo).
 *
 * Objetivo: o mesmo código-base atende Mais Prime, Mais Prime RS, Hertz e
 * futuras empresas do grupo — mudando apenas o `.env`, sem fork de código.
 *
 * IMPORTANTE — compatibilidade:
 * Os defaults deste arquivo reproduzem exatamente o comportamento anterior
 * (bases MAIS_PRIME e MAIS_PRIME_RS, com os mesmos nomes de env e a mesma
 * marca). Um deploy existente que não definir nenhuma variável `TENANT_*`
 * continua funcionando de forma idêntica.
 *
 * A leitura é preguiçosa (lazy) e memoizada: a config só é montada no
 * primeiro acesso, garantindo que o `.env` já esteja carregado em
 * `process.env` independentemente da ordem de import dos módulos.
 */

/**
 * Identificador de base de origem (tenant).
 *
 * Deixou de ser uma união literal para permitir bases definidas em runtime.
 * A validação dos valores aceitos é feita por `isTenantBase()`.
 */
export type BaseOrigin = string;

/** Integrações externas que possuem credencial por base. */
export type TenantTokenKind =
  | 'sgaUser'
  | 'sgaPassword'
  | 'sgaBaseToken'
  | 'logica'
  | 'softruck'
  | 'softruckUsername'
  | 'softruckPassword'
  | 'softruckPublicKey'
  | 'clubgas'
  | 'm7Token'
  | 'm7Codigo'
  | 'apiSecretAlloyal'
  | 'alloyalBusinessId'
  | 'alloyalBusinessCnpj';

export interface TenantBaseDefinition {
  /** Valor gravado em `user.baseOrigin` e no JWT. Ex.: `MAIS_PRIME`. */
  name: string;
  /** Sufixo aplicado aos nomes de env desta base. Ex.: `` ou `_RS`. */
  envSuffix: string;
}

/**
 * Bases padrão — reproduz o mapa literal que existia em
 * `token-resolver.service.ts` antes da parametrização.
 */
const DEFAULT_TENANT_BASES = 'MAIS_PRIME:,MAIS_PRIME_RS:_RS';

/** Marca padrão — mantém os textos atuais em e-mails e PDFs. */
const DEFAULT_TENANT_NAME = 'Mais Prime';

/** URL base padrão de documentos — preserva o valor que estava hardcoded. */
const DEFAULT_DOCUMENTS_BASE_URL = 'https://app-dev.texvngroup.com.br';

/** Integrações exigidas no boot, por base. Ver `TENANT_REQUIRED_INTEGRATIONS`. */
const DEFAULT_REQUIRED_INTEGRATIONS = 'sga,softruckPublicKey,logica';

/**
 * Como o nome de cada variável de ambiente é derivado da base.
 *
 * Duas convenções coexistem no projeto e ambas são preservadas:
 *  - SGA usa o **nome da base** no final (`USER_SGA_MAIS_PRIME_RS`);
 *  - as demais usam um **sufixo** (`LOGICA_TOKEN_RS`, `MO7_TOKEN_RS`).
 */
const ENV_NAME_TEMPLATES: Record<
  TenantTokenKind,
  (base: TenantBaseDefinition) => string
> = {
  sgaUser: (b) => `USER_SGA_${b.name}`,
  sgaPassword: (b) => `PASSWORD_SGA_${b.name}`,
  sgaBaseToken: (b) => `TOKEN_BASE_SGA_${b.name}`,
  logica: (b) => `LOGICA_TOKEN${b.envSuffix}`,
  softruck: (b) => `SOFTRUCK_TOKEN${b.envSuffix}`,
  softruckUsername: (b) => `USERNAME_SOFTRUCK${b.envSuffix}`,
  softruckPassword: (b) => `PASSWORD_SOFTRUCK${b.envSuffix}`,
  softruckPublicKey: (b) => `PUBLIC_KEY_SOFTRUCK${b.envSuffix}`,
  clubgas: (b) => `TOKEN_API_CLUBGAS${b.envSuffix}`,
  m7Token: (b) => `MO7_TOKEN${b.envSuffix}`,
  m7Codigo: (b) => `M07_CODIGO${b.envSuffix}`,
  apiSecretAlloyal: (b) => `API_SECRET_ALLOYAL${b.envSuffix}`,
  alloyalBusinessId: (b) => `ALLOYAL_BUSINESS_ID${b.envSuffix}`,
  alloyalBusinessCnpj: (b) => `ALLOYAL_BUSINESS_CNPJ${b.envSuffix}`,
};

interface TenantConfig {
  bases: TenantBaseDefinition[];
  baseNames: string[];
  defaultBase: string;
  envNames: Record<string, Record<TenantTokenKind, string>>;
  requiredIntegrations: TenantTokenKind[];
  name: string;
  appName: string;
  reportName: string;
  logoPath: string;
  mailPrevia: string;
  mailCobranca: string;
  documentsBaseUrl: string;
}

let cached: TenantConfig | null = null;

/**
 * Interpreta `TENANT_BASES`.
 *
 * Formato de cada entrada: `NOME` ou `NOME:SUFIXO`.
 *  - `MAIS_PRIME:` → base MAIS_PRIME sem sufixo (envs sem sufixo)
 *  - `MAIS_PRIME_RS:_RS` → envs terminadas em `_RS`
 *  - `HERTZ` → primeira base sem `:` fica sem sufixo
 *
 * Sem `:`, a primeira base fica com sufixo vazio e as demais com `_<NOME>`.
 */
function parseBases(raw: string): TenantBaseDefinition[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error(
      'TENANT_BASES está vazio: defina ao menos uma base (ex.: TENANT_BASES=HERTZ)',
    );
  }

  const bases = entries.map((entry, index) => {
    const separatorIndex = entry.indexOf(':');

    if (separatorIndex === -1) {
      const name = entry.toUpperCase();
      return {
        name,
        envSuffix: index === 0 ? '' : `_${name}`,
      };
    }

    const name = entry.slice(0, separatorIndex).trim().toUpperCase();
    const envSuffix = entry.slice(separatorIndex + 1).trim();

    if (!name) {
      throw new Error(`TENANT_BASES contém entrada inválida: "${entry}"`);
    }

    return { name, envSuffix };
  });

  const duplicated = bases
    .map((base) => base.name)
    .filter((name, index, all) => all.indexOf(name) !== index);

  if (duplicated.length > 0) {
    throw new Error(
      `TENANT_BASES contém bases duplicadas: ${duplicated.join(', ')}`,
    );
  }

  return bases;
}

function parseRequiredIntegrations(raw: string): TenantTokenKind[] {
  const known = Object.keys(ENV_NAME_TEMPLATES) as TenantTokenKind[];

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .flatMap((item): TenantTokenKind[] => {
      // Atalho: "sga" expande para as três credenciais do SGA.
      if (item === 'sga') {
        return ['sgaUser', 'sgaPassword', 'sgaBaseToken'];
      }

      if (!known.includes(item as TenantTokenKind)) {
        throw new Error(
          `TENANT_REQUIRED_INTEGRATIONS contém integração desconhecida: "${item}"`,
        );
      }

      return [item as TenantTokenKind];
    });
}

function build(): TenantConfig {
  const bases = parseBases(process.env.TENANT_BASES ?? DEFAULT_TENANT_BASES);
  const baseNames = bases.map((base) => base.name);

  const configuredDefault =
    process.env.TENANT_DEFAULT_BASE?.trim().toUpperCase();

  if (configuredDefault && !baseNames.includes(configuredDefault)) {
    throw new Error(
      `TENANT_DEFAULT_BASE="${configuredDefault}" não está em TENANT_BASES (${baseNames.join(', ')})`,
    );
  }

  const defaultBase = configuredDefault ?? baseNames[0];

  const envNames: Record<string, Record<TenantTokenKind, string>> = {};
  for (const base of bases) {
    const kinds = Object.keys(ENV_NAME_TEMPLATES) as TenantTokenKind[];
    envNames[base.name] = kinds.reduce(
      (acc, kind) => {
        acc[kind] = ENV_NAME_TEMPLATES[kind](base);
        return acc;
      },
      {} as Record<TenantTokenKind, string>,
    );
  }

  const name = process.env.TENANT_NAME?.trim() || DEFAULT_TENANT_NAME;

  return {
    bases,
    baseNames,
    defaultBase,
    envNames,
    requiredIntegrations: parseRequiredIntegrations(
      process.env.TENANT_REQUIRED_INTEGRATIONS ?? DEFAULT_REQUIRED_INTEGRATIONS,
    ),
    name,
    appName: process.env.TENANT_APP_NAME?.trim() || `${name} App`,
    reportName: process.env.TENANT_REPORT_NAME?.trim() || name,
    logoPath: process.env.TENANT_LOGO_PATH?.trim() || 'assets/Logo.png',
    mailPrevia: process.env.MAIL_TO_PREVIA?.trim() || 'previa@maisprime.org.br',
    mailCobranca:
      process.env.MAIL_TO_COBRANCA?.trim() || 'cobranca@maisprime.org.br',
    documentsBaseUrl:
      process.env.TENANT_DOCUMENTS_BASE_URL?.trim() ||
      process.env.APP_URL?.trim() ||
      DEFAULT_DOCUMENTS_BASE_URL,
  };
}

function config(): TenantConfig {
  if (!cached) {
    cached = build();
  }
  return cached;
}

/**
 * Reconstrói a config a partir de `process.env`.
 * Uso exclusivo de testes — não chamar em runtime de produção.
 */
export function resetTenantConfigCache(): void {
  cached = null;
}

/**
 * Config de tenant. Todas as propriedades são preguiçosas: só leem
 * `process.env` no primeiro acesso.
 */
export const TENANT = {
  /** Definições completas (nome + sufixo de env) de cada base. */
  get bases(): TenantBaseDefinition[] {
    return config().bases;
  },

  /** Nomes das bases deste deploy. Ex.: `['MAIS_PRIME', 'MAIS_PRIME_RS']`. */
  get baseNames(): string[] {
    return config().baseNames;
  },

  /**
   * Base usada como fallback quando não é possível resolver a base
   * de origem a partir do JWT ou do banco.
   */
  get defaultBase(): BaseOrigin {
    return config().defaultBase;
  },

  /** Integrações cujas credenciais são obrigatórias no boot. */
  get requiredIntegrations(): TenantTokenKind[] {
    return config().requiredIntegrations;
  },

  /** Nome comercial da empresa. Ex.: `Mais Prime`. */
  get name(): string {
    return config().name;
  },

  /** Nome usado como remetente de e-mail. Ex.: `Mais Prime App`. */
  get appName(): string {
    return config().appName;
  },

  /** Nome usado no rodapé dos relatórios em PDF. */
  get reportName(): string {
    return config().reportName;
  },

  /** Caminho da logo (relativo ao cwd) usada nos PDFs. */
  get logoPath(): string {
    return config().logoPath;
  },

  /** Destinatário dos e-mails de prévia de revistoria. */
  get mailPrevia(): string {
    return config().mailPrevia;
  },

  /** Destinatário dos e-mails de cobrança. */
  get mailCobranca(): string {
    return config().mailCobranca;
  },

  /** URL base pública usada para montar links de documentos. */
  get documentsBaseUrl(): string {
    return config().documentsBaseUrl;
  },
};

/** Indica se o valor informado é uma base válida neste deploy. */
export function isTenantBase(value: unknown): value is BaseOrigin {
  return typeof value === 'string' && TENANT.baseNames.includes(value);
}

/**
 * Nome da variável de ambiente que guarda a credencial `kind` da base `base`.
 *
 * @throws se a base não pertencer a este deploy.
 */
export function tenantEnvName(base: BaseOrigin, kind: TenantTokenKind): string {
  const names = config().envNames[base];

  if (!names) {
    throw new Error(
      `Base de origem desconhecida: "${base}". Bases configuradas: ${TENANT.baseNames.join(', ')}`,
    );
  }

  return names[kind];
}

/**
 * Cria um registro com uma entrada por base configurada.
 * Substitui os mapas literais `{ MAIS_PRIME: ..., MAIS_PRIME_RS: ... }`.
 */
export function mapTenantBases<T>(
  factory: (base: BaseOrigin) => T,
): Record<BaseOrigin, T> {
  return TENANT.baseNames.reduce<Record<BaseOrigin, T>>((acc, base) => {
    acc[base] = factory(base);
    return acc;
  }, {});
}
