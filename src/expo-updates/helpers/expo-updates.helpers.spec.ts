import { createVerify, generateKeyPairSync } from 'crypto';
import {
  assinarRsaSha256,
  caminhoRelativoSeguro,
  contentTypePorExtensao,
  gerarNomeRelease,
  hashParaUuid,
  montarHeaderAssinatura,
  montarMultipartMixed,
  normalizarCaminhoRelativo,
  sha256Base64Url,
} from './expo-updates.helpers';

describe('expo-updates helpers', () => {
  it('hashParaUuid formata os 32 primeiros hex como UUID', () => {
    expect(hashParaUuid('0123456789abcdef0123456789abcdefFFFFFFFF')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    );
    expect(() => hashParaUuid('zz')).toThrow();
  });

  it('sha256Base64Url usa alfabeto URL-safe sem padding', () => {
    const hash = sha256Base64Url(Buffer.from('expo'));
    expect(hash).not.toMatch(/[+/=]/);
    expect(hash).toHaveLength(43);
  });

  it('contentTypePorExtensao cobre imagens, fontes e fallback', () => {
    expect(contentTypePorExtensao('png')).toBe('image/png');
    expect(contentTypePorExtensao('.ttf')).toBe('font/ttf');
    expect(contentTypePorExtensao('xyz')).toBe('application/octet-stream');
    expect(contentTypePorExtensao(null)).toBe('application/octet-stream');
  });

  it('assinatura RSA-SHA256 é verificável com a chave pública', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const dados = JSON.stringify({ id: 'abc' });
    const sig = assinarRsaSha256(dados, privateKey);

    const verify = createVerify('RSA-SHA256');
    verify.update(dados, 'utf8');
    verify.end();
    expect(verify.verify(publicKey, sig, 'base64')).toBe(true);

    expect(montarHeaderAssinatura(sig, 'main')).toBe(
      `sig="${sig}", keyid="main"`,
    );
  });

  it('montarMultipartMixed gera partes com CRLF e boundary final', () => {
    const { boundary, corpo } = montarMultipartMixed([
      {
        nome: 'manifest',
        corpo: '{"a":1}',
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
    const texto = corpo.toString('utf8');
    expect(texto).toBe(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="manifest"\r\n` +
        `Content-Type: application/json\r\n` +
        `\r\n` +
        `{"a":1}\r\n` +
        `--${boundary}--\r\n`,
    );
  });

  it('gerarNomeRelease é ordenável por data', () => {
    const a = gerarNomeRelease(new Date('2026-01-01T00:00:00Z'));
    const b = gerarNomeRelease(new Date('2026-01-01T00:00:01Z'));
    expect(a.startsWith('20260101-000000-')).toBe(true);
    expect(a < b).toBe(true);
  });

  it('normaliza e valida caminhos relativos contra traversal', () => {
    expect(normalizarCaminhoRelativo('.\\dist\\metadata.json')).toBe(
      'dist/metadata.json',
    );
    expect(caminhoRelativoSeguro('assets/abc')).toBe(true);
    expect(caminhoRelativoSeguro('../etc/passwd')).toBe(false);
    expect(caminhoRelativoSeguro('a//b')).toBe(false);
    expect(caminhoRelativoSeguro('')).toBe(false);
  });
});
