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
];

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
