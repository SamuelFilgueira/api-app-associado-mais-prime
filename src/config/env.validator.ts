import { Logger } from '@nestjs/common';

// Variáveis obrigatórias — app NÃO sobe sem elas
const REQUIRED = [
  'JWT_SECRET',
  'DATABASE_URL',
  'USER_SGA_MAIS_PRIME',
  'PASSWORD_SGA_MAIS_PRIME',
  'TOKEN_BASE_SGA_MAIS_PRIME',
  'USER_SGA_MAIS_PRIME_RS',
  'PASSWORD_SGA_MAIS_PRIME_RS',
  'TOKEN_BASE_SGA_MAIS_PRIME_RS',
  'LOGICA_TOKEN',
  'PUBLIC_KEY_SOFTRUCK',
  'PUBLIC_KEY_SOFTRUCK_RS',
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
];

export function validateEnvOrThrow() {
  const logger = new Logger('EnvValidator');

  const missing = REQUIRED.filter((k) => !process.env[k]);
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
