import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Configuração do servidor de atualizações OTA (Expo Updates Protocol).
 *
 * Todas as envs são opcionais — a feature funciona só com o volume `updates/`
 * montado. Ver docs/EXPO_UPDATES_OTA.md.
 *
 * - EXPO_UPDATES_DIR: pasta onde os releases ficam (default: <cwd>/updates)
 * - EXPO_UPDATES_PUBLIC_URL: base pública usada nas URLs dos assets do
 *   manifest (default: APP_URL; último fallback: host da requisição).
 *   Valor especial `auto` = sempre usar o host da requisição (túnel em dev).
 * - EXPO_UPDATES_PRIVATE_KEY_PATH | EXPO_UPDATES_PRIVATE_KEY_BASE64: chave
 *   privada RSA (PEM) gerada por `npx expo-updates codesigning:generate`.
 *   Sem ela o manifest sai sem assinatura e um app com
 *   `codeSigningCertificate` configurado rejeita o update.
 * - EXPO_UPDATES_KEY_ID: keyid anunciado na assinatura (default: main)
 * - EXPO_UPDATES_UPLOAD_LIMIT_MB: tamanho máximo do zip de publicação (default: 200)
 */
export interface ExpoUpdatesConfig {
  diretorio: string;
  urlPublica: string | null;
  chavePrivadaPem: string | null;
  keyId: string;
  limiteUploadBytes: number;
}

export const EXPO_UPDATES_CONFIG = Symbol('EXPO_UPDATES_CONFIG');

export function limiteUploadBytes(): number {
  const mb = Number.parseInt(
    process.env.EXPO_UPDATES_UPLOAD_LIMIT_MB ?? '',
    10,
  );
  return (Number.isFinite(mb) && mb > 0 ? mb : 200) * 1024 * 1024;
}

function semBarraFinal(url: string): string {
  return url.replace(/\/+$/, '');
}

function carregarChavePrivada(logger: Logger): string | null {
  const base64 = process.env.EXPO_UPDATES_PRIVATE_KEY_BASE64?.trim();
  if (base64) {
    return Buffer.from(base64, 'base64').toString('utf8');
  }

  const caminho = process.env.EXPO_UPDATES_PRIVATE_KEY_PATH?.trim();
  if (caminho) {
    try {
      return readFileSync(resolve(process.cwd(), caminho), 'utf8');
    } catch (err) {
      logger.error(
        `Não foi possível ler a chave privada em ${caminho}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  return null;
}

export function carregarExpoUpdatesConfig(): ExpoUpdatesConfig {
  const logger = new Logger('ExpoUpdatesConfig');

  const diretorio = resolve(
    process.cwd(),
    process.env.EXPO_UPDATES_DIR?.trim() || 'updates',
  );

  // "auto": URLs dos assets seguem o host de cada requisição (x-forwarded-host /
  // host). Útil em desenvolvimento com túnel (a URL muda a cada reinício).
  // Em produção, prefira URL fixa (EXPO_UPDATES_PUBLIC_URL ou APP_URL).
  const urlEnvBruta = process.env.EXPO_UPDATES_PUBLIC_URL?.trim();
  const modoAuto = urlEnvBruta?.toLowerCase() === 'auto';
  const urlEnv = modoAuto
    ? undefined
    : urlEnvBruta || process.env.APP_URL?.trim();
  const urlPublica = urlEnv ? semBarraFinal(urlEnv) : null;

  const chavePrivadaPem = carregarChavePrivada(logger);
  if (!chavePrivadaPem) {
    logger.warn(
      'Code signing DESABILITADO (EXPO_UPDATES_PRIVATE_KEY_PATH/BASE64 ausente). ' +
        'Apps com codeSigningCertificate configurado vão recusar os updates.',
    );
  }

  if (modoAuto) {
    logger.log(
      'EXPO_UPDATES_PUBLIC_URL=auto — URLs dos assets seguem o host de cada requisição (modo desenvolvimento/túnel).',
    );
  } else if (!urlPublica) {
    logger.warn(
      'EXPO_UPDATES_PUBLIC_URL/APP_URL ausente — URLs dos assets usarão o host da requisição.',
    );
  }

  return {
    diretorio,
    urlPublica,
    chavePrivadaPem,
    keyId: process.env.EXPO_UPDATES_KEY_ID?.trim() || 'main',
    limiteUploadBytes: limiteUploadBytes(),
  };
}
