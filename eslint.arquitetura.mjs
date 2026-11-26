// @ts-check
/**
 * Regras de ARQUITETURA, verificadas por ferramenta (`npm run lint:arquitetura`).
 *
 * Separadas do `eslint.config.mjs` de propósito: o lint geral tem uma linha de
 * base de avisos do legado e não bloqueia o CI; este arquivo só tem regras de
 * dependência, roda sem informação de tipo (rápido) e TEM de passar.
 *
 * Cada regra traz uma lista de exceções do legado. As listas só podem
 * DIMINUIR: arquivo novo nunca entra nelas — se a regra incomoda, o código
 * novo está no lugar errado.
 */
import tseslint from 'typescript-eslint';
import { LEGADO } from './eslint.arquitetura.legado.mjs';

const SEM_PROCESS_ENV = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message:
    'process.env só é lido em src/config (regra do CLAUDE.md). Exponha o valor por uma função de config.',
};

const SEM_BASE_PADRAO = {
  selector:
    "MemberExpression[object.name='TENANT'][property.name='defaultBase']",
  message:
    'Nada de cair na base padrão: use exigirBase() (src/shared/tenant/tenant-context.ts). Sem base, a operação falha.',
};

/** @param {string[]} padroes @param {string} mensagem @param {boolean} [permitirTipos] */
const proibirImport = (padroes, mensagem, permitirTipos = false) => ({
  group: padroes,
  message: mensagem,
  ...(permitirTipos ? { allowTypeImports: true } : {}),
});

const IMPORTS_DE_VENDOR = [
  proibirImport(
    ['puppeteer', 'puppeteer-core'],
    'Chromium só em src/infra/pdf: peça o PDF pela porta PdfRenderer.',
  ),
  proibirImport(
    ['expo-server-sdk'],
    'SDK do Expo só em src/integrations/expo: envie push pela porta PushGateway.',
  ),
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'test/**',
      'scripts/**',
      'prisma/**',
      '**/*.spec.ts',
      '**/testing/**',
      'eslint*.mjs',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      'no-restricted-syntax': ['error', SEM_PROCESS_ENV, SEM_BASE_PADRAO],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            ...IMPORTS_DE_VENDOR,
            proibirImport(
              ['axios'],
              'HTTP para terceiros só em src/integrations/<vendor> (client com timeout, métrica e erro tipado).',
              true,
            ),
            proibirImport(
              ['ioredis'],
              'Conexão com o Redis só em src/infra/redis: injete REDIS_CLIENTE, CacheService ou VendorSessionStore.',
              true,
            ),
          ],
        },
      ],
    },
  },

  // ── Onde cada dependência PODE aparecer ──────────────────────────────
  {
    files: ['src/config/**/*.ts', 'src/main.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['src/integrations/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [IMPORTS_DE_VENDOR[0]] },
      ],
    },
  },
  {
    files: ['src/integrations/expo/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
  {
    files: ['src/infra/pdf/**/*.ts', 'src/infra/redis/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
  // Os submódulos de provedor do rastreamento SÃO os adaptadores de vendor
  // (M7, Lógica, Softruck): falam HTTP com o provedor, como `integrations`.
  {
    files: ['src/rastreamento/{m7,logica,softruck}/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            ...IMPORTS_DE_VENDOR,
            proibirImport(
              ['ioredis'],
              'Conexão com o Redis só em src/infra/redis: injete REDIS_CLIENTE, CacheService ou VendorSessionStore.',
              true,
            ),
          ],
        },
      ],
    },
  },

  // ── Domínio puro ─────────────────────────────────────────────────────
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            proibirImport(
              [
                '@nestjs/*',
                'axios',
                'ioredis',
                'bullmq',
                'puppeteer',
                'expo-server-sdk',
              ],
              'domain/ é regra pura: sem framework, HTTP, fila ou Redis.',
            ),
            proibirImport(
              ['@prisma/client'],
              'domain/ não acessa o banco (só tipos gerados, com `import type`).',
              true,
            ),
            proibirImport(
              [
                'src/database/**',
                'src/infra/**',
                'src/queue/**',
                '**/repositories/**',
                '**/controllers/**',
              ],
              'domain/ não depende de infraestrutura nem das camadas de fora.',
            ),
            // Tipo de porta (contrato de um vendor) pode ser citado pelo
            // domínio; código de `integrations` em tempo de execução, não.
            proibirImport(
              ['src/integrations/**'],
              'domain/ só importa TIPOS de src/integrations (`import type`).',
              true,
            ),
          ],
        },
      ],
    },
  },

  // ── Controllers não falam com o banco ────────────────────────────────
  {
    files: ['src/**/controllers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            ...IMPORTS_DE_VENDOR,
            proibirImport(
              ['axios'],
              'Controller não chama vendor: delegue ao service.',
              true,
            ),
            proibirImport(
              ['src/database/prisma.service'],
              'Controller não acessa o Prisma: delegue ao service/repository.',
            ),
          ],
        },
      ],
    },
  },

  // ── Transversais não dependem de módulo de domínio ───────────────────
  {
    files: ['src/shared/**/*.ts', 'src/config/**/*.ts', 'src/queue/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            proibirImport(
              [
                'src/sga/**',
                'src/reinspection/**',
                'src/rastreamento/**',
                'src/notifications/**',
                'src/beneficios/**',
                'src/associado/**',
                'src/associado-sorte/**',
                'src/boleto-notificacao/**',
                'src/analytics/**',
                'src/cartao/**',
                'src/auth/**',
              ],
              'Código transversal não importa módulo de domínio (a dependência é do domínio para o transversal).',
            ),
          ],
        },
      ],
    },
  },

  // ── Exceções do legado (só diminuem) ─────────────────────────────────
  {
    files: LEGADO.processEnv,
    rules: { 'no-restricted-syntax': ['error', SEM_BASE_PADRAO] },
  },
  {
    files: LEGADO.importsRestritos,
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
);
