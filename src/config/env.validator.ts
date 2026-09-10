import { Logger } from '@nestjs/common';
import { TENANT, tenantEnvName } from './tenant.config';

// Variáveis obrigatórias independentes de tenant — app NÃO sobe sem elas
const REQUIRED_BASE = [
  'JWT_SECRET',
  'DATABASE_URL',
  'REDIS_HOST',
  'ANALYTICS_SECRET',
];

// Variáveis importantes — app sobe mas emite warning visível
const WARN_IF_MISSING = [
  'GMAIL_USER',
  'SENHA_APP',
  'ADMIN_PANEL_TOKEN',
  'TOKEN_API_CLUBGAS',
  'BASE_URL_ALLOYAL',
  'M7_API_BASE_URL',
  'M7_WEBHOOK_TOKEN',
  'LOGICA_API_BASE_URL',
  'LOGICA_API_NUMBER',
  'SOFTRUCK_API_BASE_URL',
  //'PUPPETEER_EXECUTABLE_PATH',
  'suri_baseUrl',
  'token_suri',
  'suri_template_id',
  'suri_template_id_boleto_pago',
  'channelId',
  'sendTo',
  'x_clientemployee_email',
  'x_clientemployee_token',
  // Rotina de notificações de boleto (opt-in explícito; demais envs têm default)
  'BOLETO_NOTIFICACAO_ENABLED',
  // E-mail transacional via Amazon SES (mail.service.ts usa `!` nessas envs:
  // sem elas o app sobe e o envio falha só em runtime, dentro de catch)
  'MAIL_FROM',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  // Geração de PDFs (Puppeteer) — obrigatório no Docker (Chromium do sistema)
  'PUPPETEER_EXECUTABLE_PATH',
  // ClubGas (clubgas.client.ts) — sem ela o client monta URL inválida
  'CLUBGAS_BASE_URL',
];

/**
 * Envs OPCIONAIS conhecidas — documentação viva; não geram warning.
 * Ao adicionar uma env nova, classifique-a aqui, em WARN_IF_MISSING ou
 * em REQUIRED_BASE (regra do CLAUDE.md).
 *
 * - APP_URL: base pública para links de upload (file-upload.service, tenant.config)
 * - PORT / REDIS_PORT / APP_TIMEZONE: infra com default
 * - PRISMA_CONNECTION_LIMIT / PRISMA_POOL_TIMEOUT: pool MySQL (prisma.service)
 * - CEPABERTO_TOKEN / CEPABERTO_API_TOKEN: geocodificação de oficinas
 *   (oficina.service aceita os dois nomes; sem token, oficina fica sem coordenadas)
 * - ENABLE_TEST_ENDPOINTS: habilita rotas de teste (auth.controller)
 * - M7_NOMINATIM_DB / M7_NOMINATIM_TABLE / M7_NOMINATIM_ENABLED /
 *   M7_REV_GEOCODE_CACHE_PROVIDERS / M7_REV_GEOCODE_CACHE_RADIUS_KEYS /
 *   M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK: reverse geocode M7 (defaults no service)
 * - SOFTRUCK_REV_GEOCODE_TIMEOUT_MS: timeout do reverse geocode Softruck
 * - ANALYTICS_JOURNEY_ENABLED / ANALYTICS_LINK_USER_ENABLED /
 *   ANALYTICS_RATE_LIMIT_ENABLED / ANALYTICS_JOURNEY_TTL_DAYS: flags do analytics
 * - BOLETO_NOTIFICACAO_*: demais knobs da rotina de boletos (defaults validados
 *   em boleto-notificacao.config.ts)
 * - EXPO_UPDATES_DIR / EXPO_UPDATES_PUBLIC_URL / EXPO_UPDATES_PRIVATE_KEY_PATH /
 *   EXPO_UPDATES_PRIVATE_KEY_BASE64 / EXPO_UPDATES_KEY_ID /
 *   EXPO_UPDATES_UPLOAD_LIMIT_MB: servidor OTA self-hosted (expo-updates.config.ts
 *   loga warning no boot se a chave de code signing estiver ausente)
 */

/**
 * Monta a lista de envs obrigatórias das integrações, por base configurada.
 *
 * Quais integrações entram é controlado por `TENANT_REQUIRED_INTEGRATIONS`
 * (default: `sga,softruckPublicKey,logica`). Uma empresa que ainda não
 * contratou Softruck ou Lógica pode reduzir a lista sem tocar em código.
 *
 * `LOGICA_TOKEN` é exigido apenas da base padrão, replicando o
 * comportamento anterior à parametrização.
 */
function requiredTenantEnvVars(): string[] {
  const vars = new Set<string>();

  for (const base of TENANT.baseNames) {
    for (const kind of TENANT.requiredIntegrations) {
      if (kind === 'logica' && base !== TENANT.defaultBase) {
        continue;
      }
      vars.add(tenantEnvName(base, kind));
    }
  }

  return [...vars];
}

export function validateEnvOrThrow() {
  const logger = new Logger('EnvValidator');

  logger.log(
    `Tenant: ${TENANT.name} | bases=[${TENANT.baseNames.join(', ')}] | base padrão=${TENANT.defaultBase}`,
  );

  const required = [...REQUIRED_BASE, ...requiredTenantEnvVars()];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error(`Variáveis de ambiente ausentes: ${missing.join(', ')}`);
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  const warned = WARN_IF_MISSING.filter((k) => !process.env[k]);
  if (warned.length) {
    logger.warn(
      `Variáveis de ambiente não configuradas (funcionalidades podem estar indisponíveis): ${warned.join(', ')}`,
    );
  }

  logger.log('Environment variables validated');
}
