import { createHash, createSign, randomBytes } from 'crypto';

/** Regex dos segmentos de caminho aceitos (runtimeVersion e nome de release). */
export const SEGMENTO_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sha256Hex(dados: Buffer | string): string {
  return createHash('sha256').update(dados).digest('hex');
}

export function sha256Base64Url(dados: Buffer): string {
  return createHash('sha256')
    .update(dados)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function md5Hex(dados: Buffer): string {
  return createHash('md5').update(dados).digest('hex');
}

/** Converte os 32 primeiros hex de um hash em UUID (formato exigido para `id`). */
export function hashParaUuid(hex: string): string {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]{32,}$/.test(h)) {
    throw new Error('hashParaUuid: esperado hash hexadecimal com >= 32 chars');
  }
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  js: 'application/javascript',
  hbc: 'application/javascript',
  bundle: 'application/javascript',
};

export function contentTypePorExtensao(ext: string | null | undefined): string {
  if (!ext) return 'application/octet-stream';
  return (
    CONTENT_TYPES[ext.replace(/^\./, '').toLowerCase()] ??
    'application/octet-stream'
  );
}

/** Assina com RSA PKCS#1 v1.5 + SHA-256 (alg `rsa-v1_5-sha256` do protocolo). */
export function assinarRsaSha256(dados: string, chavePem: string): string {
  const sign = createSign('RSA-SHA256');
  sign.update(dados, 'utf8');
  sign.end();
  return sign.sign(chavePem, 'base64');
}

/** Header `expo-signature` em Structured Field Dictionary: sig="...", keyid="..." */
export function montarHeaderAssinatura(sig: string, keyId: string): string {
  const escapar = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `sig="${escapar(sig)}", keyid="${escapar(keyId)}"`;
}

export interface ParteMultipart {
  nome: string;
  corpo: string;
  headers?: Record<string, string>;
}

/** Monta um corpo `multipart/mixed` no layout que o expo-updates espera. */
export function montarMultipartMixed(partes: ParteMultipart[]): {
  boundary: string;
  corpo: Buffer;
} {
  const boundary = `expo-updates-${randomBytes(16).toString('hex')}`;
  const linhas: string[] = [];

  for (const parte of partes) {
    linhas.push(`--${boundary}`);
    linhas.push(`Content-Disposition: form-data; name="${parte.nome}"`);
    for (const [k, v] of Object.entries(parte.headers ?? {})) {
      linhas.push(`${k}: ${v}`);
    }
    linhas.push('');
    linhas.push(parte.corpo);
  }
  linhas.push(`--${boundary}--`);
  linhas.push('');

  return { boundary, corpo: Buffer.from(linhas.join('\r\n'), 'utf8') };
}

/**
 * Nome de pasta de release: `YYYYMMDD-HHmmss-SSS` (UTC, com milissegundos).
 * Ordenável lexicograficamente — a ordem dos nomes É a ordem de publicação.
 */
export function gerarNomeRelease(agora = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return (
    `${agora.getUTCFullYear()}${p(agora.getUTCMonth() + 1)}${p(agora.getUTCDate())}` +
    `-${p(agora.getUTCHours())}${p(agora.getUTCMinutes())}${p(agora.getUTCSeconds())}` +
    `-${p(agora.getUTCMilliseconds(), 3)}`
  );
}

/** Inverso de `gerarNomeRelease`; null se o nome não segue o formato. */
export function nomeReleaseParaData(nome: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})/.exec(nome);
  if (!m) return null;
  const [, a, me, d, h, mi, s, ms] = m.map(Number);
  return new Date(Date.UTC(a, me - 1, d, h, mi, s, ms));
}

/** Normaliza caminho vindo do zip/query: barras invertidas → `/`, sem `./` inicial. */
export function normalizarCaminhoRelativo(caminho: string): string {
  return caminho
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

/** Rejeita segmentos vazios, `.` e `..` — proteção contra path traversal. */
export function caminhoRelativoSeguro(caminho: string): boolean {
  if (!caminho || caminho.includes('\0')) return false;
  const segmentos = caminho.split('/');
  return segmentos.every((s) => s !== '' && s !== '.' && s !== '..');
}
