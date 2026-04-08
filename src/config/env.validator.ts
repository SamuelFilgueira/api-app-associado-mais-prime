import { Logger } from '@nestjs/common';

const REQUIRED = [
  'SGA_TOKEN',
  'SGA_TOKEN_RS',
  'LOGICA_TOKEN',
  'LOGICA_TOKEN_RS',
  'PUBLIC_KEY_SOFTRUCK',
  'PUBLIC_KEY_SOFTRUCK_RS',
];

export function validateEnvOrThrow() {
  const logger = new Logger('EnvValidator');
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error(`Variáveis de ambiente ausentes: ${missing.join(', ')}`);
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  logger.log('Environment variables validated');
}
