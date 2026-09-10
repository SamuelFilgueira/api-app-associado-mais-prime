import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import AdmZip from 'adm-zip';
import { createHash, createVerify, generateKeyPairSync } from 'crypto';
import { promises as fs } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { ExpoUpdatesModule } from './expo-updates.module';

const URL_PUBLICA = 'https://api.teste.com.br';
const ADMIN_TOKEN = 'token-admin-teste';
const RUNTIME = '1.2.3';

/** Simula a saída de `npx expo export --platform all` em um zip. */
function criarZipExport(opts: { conteudoBundle: string; prefixo?: string }) {
  const zip = new AdmZip();
  const p = opts.prefixo ?? '';
  const bundleAndroid = '_expo/static/js/android/index-aaa.hbc';
  const bundleIos = '_expo/static/js/ios/index-bbb.hbc';
  const asset = 'assets/0123456789abcdef0123456789abcdef';

  zip.addFile(`${p}${bundleAndroid}`, Buffer.from(opts.conteudoBundle));
  zip.addFile(`${p}${bundleIos}`, Buffer.from(`ios:${opts.conteudoBundle}`));
  zip.addFile(`${p}${asset}`, Buffer.from('PNGDATA'));
  zip.addFile(
    `${p}metadata.json`,
    Buffer.from(
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: {
          android: {
            bundle: bundleAndroid,
            assets: [{ path: asset, ext: 'png' }],
          },
          ios: { bundle: bundleIos, assets: [{ path: asset, ext: 'png' }] },
        },
      }),
    ),
  );
  zip.addFile(
    `${p}expoConfig.json`,
    Buffer.from(
      JSON.stringify({ name: 'App', slug: 'app', runtimeVersion: RUNTIME }),
    ),
  );
  return { buffer: zip.toBuffer(), bundleAndroid, asset };
}

/** superagent só bufferiza text/json — força coleta bruta do corpo. */
const parserBinario = (
  res: request.Response,
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const texto = (res: request.Response): string =>
  Buffer.isBuffer(res.body) ? res.body.toString('utf8') : (res.text ?? '');

/** Extrai as partes de uma resposta multipart/mixed. */
function partesMultipart(contentType: string, corpo: string) {
  const boundary = /boundary=(.+)$/.exec(contentType)![1];
  return corpo
    .split(`--${boundary}`)
    .filter((p) => p.trim() && p.trim() !== '--')
    .map((bloco) => {
      const [cabecalhos, ...resto] = bloco
        .replace(/^\r\n/, '')
        .split('\r\n\r\n');
      const headers: Record<string, string> = {};
      for (const linha of cabecalhos.split('\r\n')) {
        const idx = linha.indexOf(':');
        if (idx > 0) {
          headers[linha.slice(0, idx).trim().toLowerCase()] = linha
            .slice(idx + 1)
            .trim();
        }
      }
      const nome = /name="([^"]+)"/.exec(
        headers['content-disposition'] ?? '',
      )?.[1];
      return {
        nome,
        headers,
        corpo: resto.join('\r\n\r\n').replace(/\r\n$/, ''),
      };
    });
}

describe('ExpoUpdatesModule (HTTP)', () => {
  let app: INestApplication;
  let dir: string;
  let publicKey: string;

  const envOriginal = { ...process.env };
  const servidor = () => app.getHttpServer() as Server;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'expo-updates-spec-'));

    const chaves = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    publicKey = chaves.publicKey;

    process.env.EXPO_UPDATES_DIR = dir;
    process.env.EXPO_UPDATES_PUBLIC_URL = `${URL_PUBLICA}/`;
    process.env.EXPO_UPDATES_PRIVATE_KEY_BASE64 = Buffer.from(
      chaves.privateKey,
    ).toString('base64');
    process.env.ADMIN_PANEL_TOKEN = ADMIN_TOKEN;
    delete process.env.EXPO_UPDATES_PRIVATE_KEY_PATH;

    const moduleRef = await Test.createTestingModule({
      imports: [ExpoUpdatesModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    app?.getHttpServer()?.closeAllConnections?.();
    await app?.close();
    await fs.rm(dir, { recursive: true, force: true });
    process.env = envOriginal;
  }, 20000);

  const manifestReq = (headers: Record<string, string>) =>
    request(servidor())
      .get('/api/expo-updates/manifest')
      .buffer(true)
      .parse(parserBinario)
      .set('expo-protocol-version', '1')
      .set('expo-platform', 'android')
      .set('expo-runtime-version', RUNTIME)
      .set('expo-expect-signature', 'sig, keyid="main", alg="rsa-v1_5-sha256"')
      .set(headers);

  const publicar = (
    zip: Buffer,
    campos: Record<string, string> = { runtimeVersion: RUNTIME },
    token = ADMIN_TOKEN,
  ) => {
    let r = request(servidor())
      .post('/api/expo-updates/admin/publicar')
      .set('x-admin-token', token)
      .attach('arquivo', zip, 'dist.zip');
    for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
    return r;
  };

  it('responde 204 quando não há release para o runtime', async () => {
    const res = await manifestReq({});
    expect(res.status).toBe(204);
    expect(res.headers['expo-protocol-version']).toBe('1');
  });

  it('rejeita plataforma inválida e token admin errado', async () => {
    const res = await manifestReq({ 'expo-platform': 'web' });
    expect(res.status).toBe(400);

    const { buffer } = criarZipExport({ conteudoBundle: 'v1' });
    const pub = await publicar(buffer, { runtimeVersion: RUNTIME }, 'errado');
    expect(pub.status).toBe(401);
  });

  it('rejeita runtimeVersion divergente do expoConfig.json', async () => {
    const { buffer } = criarZipExport({ conteudoBundle: 'v1' });
    const res = await publicar(buffer, { runtimeVersion: '9.9.9' });
    expect(res.status).toBe(409);
  });

  let idV1: string;
  let nomeV1: string;

  it('publica um release (zip com pasta dist/ na raiz) e serve o manifest assinado', async () => {
    const { buffer, bundleAndroid, asset } = criarZipExport({
      conteudoBundle: 'bundle-v1',
      prefixo: 'dist/',
    });
    const pub = await publicar(buffer, {
      runtimeVersion: RUNTIME,
      descricao: 'primeira versão',
    });
    expect(pub.status).toBe(201);
    expect(pub.body.plataformas).toEqual(['android', 'ios']);
    expect(pub.body.ativa).toBe(true);
    nomeV1 = pub.body.nome;

    const res = await manifestReq({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^multipart\/mixed; boundary=/);
    expect(res.headers['expo-protocol-version']).toBe('1');

    const partes = partesMultipart(res.headers['content-type'], texto(res));
    const parteManifest = partes.find((p) => p.nome === 'manifest')!;
    const parteExt = partes.find((p) => p.nome === 'extensions')!;
    expect(parteExt).toBeDefined();
    expect(JSON.parse(parteExt.corpo)).toEqual({ assetRequestHeaders: {} });

    // assinatura válida sobre o JSON exato do corpo
    const sig = /sig="([^"]+)"/.exec(
      parteManifest.headers['expo-signature'],
    )![1];
    const verify = createVerify('RSA-SHA256');
    verify.update(parteManifest.corpo, 'utf8');
    verify.end();
    expect(verify.verify(publicKey, sig, 'base64')).toBe(true);

    const manifest = JSON.parse(parteManifest.corpo);
    idV1 = manifest.id;
    expect(manifest.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(manifest.runtimeVersion).toBe(RUNTIME);
    expect(manifest.extra.expoClient.runtimeVersion).toBe(RUNTIME);
    expect(manifest.launchAsset.contentType).toBe('application/javascript');
    expect(manifest.launchAsset.fileExtension).toBe('.bundle');
    expect(manifest.launchAsset.hash).toBe(
      createHash('sha256')
        .update('bundle-v1')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
    );
    expect(manifest.launchAsset.url).toBe(
      `${URL_PUBLICA}/api/expo-updates/assets?runtimeVersion=${RUNTIME}&release=${nomeV1}&asset=${encodeURIComponent(bundleAndroid)}`,
    );
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].contentType).toBe('image/png');
    expect(manifest.assets[0].fileExtension).toBe('.png');
    expect(manifest.assets[0].url).toContain(
      `asset=${encodeURIComponent(asset)}`,
    );
  });

  it('serve os assets com cache imutável e bloqueia path traversal', async () => {
    const asset = await request(servidor())
      .get('/api/expo-updates/assets')
      .buffer(true)
      .parse(parserBinario)
      .query({
        runtimeVersion: RUNTIME,
        release: nomeV1,
        asset: '_expo/static/js/android/index-aaa.hbc',
      });
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/application\/javascript/);
    expect(asset.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(texto(asset)).toBe('bundle-v1');

    const traversal = await request(servidor())
      .get('/api/expo-updates/assets')
      .query({ runtimeVersion: RUNTIME, release: nomeV1, asset: '../../x' });
    expect(traversal.status).toBe(400);

    const inexistente = await request(servidor())
      .get('/api/expo-updates/assets')
      .query({ runtimeVersion: RUNTIME, release: nomeV1, asset: 'nao/existe' });
    expect(inexistente.status).toBe(404);
  });

  it('devolve diretiva noUpdateAvailable quando o app já tem o update', async () => {
    const res = await manifestReq({ 'expo-current-update-id': idV1 });
    expect(res.status).toBe(200);
    const partes = partesMultipart(res.headers['content-type'], texto(res));
    const diretiva = partes.find((p) => p.nome === 'directive')!;
    expect(JSON.parse(diretiva.corpo)).toEqual({ type: 'noUpdateAvailable' });
    expect(diretiva.headers['expo-signature']).toMatch(/^sig="/);
  });

  it('protocolo 0 responde JSON puro com expo-signature no header', async () => {
    const res = await manifestReq({ 'expo-protocol-version': '0' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['expo-protocol-version']).toBe('0');
    expect(res.headers['expo-signature']).toMatch(/^sig="/);
    expect(JSON.parse(texto(res)).id).toBe(idV1);
  });

  it('rollback via republicar gera id novo e passa a ser o release servido', async () => {
    const { buffer } = criarZipExport({ conteudoBundle: 'bundle-v2' });
    const pub2 = await publicar(buffer, { runtimeVersion: RUNTIME });
    expect(pub2.status).toBe(201);

    const m2 = await manifestReq({});
    const idV2 = JSON.parse(
      partesMultipart(m2.headers['content-type'], texto(m2)).find(
        (p) => p.nome === 'manifest',
      )!.corpo,
    ).id;
    expect(idV2).not.toBe(idV1);

    const rb = await request(servidor())
      .post(`/api/expo-updates/admin/releases/${RUNTIME}/${nomeV1}/republicar`)
      .set('x-admin-token', ADMIN_TOKEN)
      .send({});
    expect(rb.status).toBe(201);
    expect(rb.body.origem).toBe(`rollback:${nomeV1}`);

    const m3 = await manifestReq({});
    const manifest3 = JSON.parse(
      partesMultipart(m3.headers['content-type'], texto(m3)).find(
        (p) => p.nome === 'manifest',
      )!.corpo,
    );
    expect(manifest3.id).not.toBe(idV1);
    expect(manifest3.id).not.toBe(idV2);
    expect(manifest3.launchAsset.url).toContain(`release=${rb.body.nome}`);

    // conteúdo servido é o do v1
    const asset = await request(servidor())
      .get('/api/expo-updates/assets')
      .buffer(true)
      .parse(parserBinario)
      .query({
        runtimeVersion: RUNTIME,
        release: rb.body.nome,
        asset: '_expo/static/js/android/index-aaa.hbc',
      });
    expect(texto(asset)).toBe('bundle-v1');
  });

  it('aceita zip com entradas em barra invertida (Compress-Archive do Windows)', async () => {
    const zip = new AdmZip();
    const bundle = '_expo\\static\\js\\android\\index-win.hbc';
    zip.addFile(bundle, Buffer.from('bundle-win'));
    zip.addFile('assets\\abc123', Buffer.from('PNG'));
    // metadata.json real do `expo export` no Windows também usa "\" nos caminhos
    zip.addFile(
      'metadata.json',
      Buffer.from(
        JSON.stringify({
          version: 0,
          bundler: 'metro',
          fileMetadata: {
            android: {
              bundle,
              assets: [{ path: 'assets\\abc123', ext: 'png' }],
            },
          },
        }),
      ),
    );
    const res = await publicar(zip.toBuffer(), { runtimeVersion: '7.0.0' });
    expect(res.status).toBe(201);
    expect(res.body.plataformas).toEqual(['android']);

    const m = await manifestReq({ 'expo-runtime-version': '7.0.0' });
    expect(m.status).toBe(200);
    const manifest = JSON.parse(
      partesMultipart(m.headers['content-type'], texto(m)).find(
        (p) => p.nome === 'manifest',
      )!.corpo,
    );
    expect(manifest.extra).toEqual({});
    // URLs saem sempre com "/" (normalizadas), nunca com "\"
    expect(manifest.launchAsset.url).toContain(
      `asset=${encodeURIComponent('_expo/static/js/android/index-win.hbc')}`,
    );
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].url).toContain(
      `asset=${encodeURIComponent('assets/abc123')}`,
    );
    const png = await request(servidor())
      .get('/api/expo-updates/assets')
      .buffer(true)
      .parse(parserBinario)
      .query({
        runtimeVersion: '7.0.0',
        release: res.body.nome,
        asset: 'assets/abc123',
        ext: 'png',
      });
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toMatch(/image\/png/);

    // iOS não existe nesse release → 204
    const ios = await manifestReq({
      'expo-runtime-version': '7.0.0',
      'expo-platform': 'ios',
    });
    expect(ios.status).toBe(204);
  });

  it('desativar deixa de servir o release e lista reflete o estado', async () => {
    const lista = await request(servidor())
      .get('/api/expo-updates/admin/releases')
      .set('x-admin-token', ADMIN_TOKEN)
      .query({ runtimeVersion: RUNTIME });
    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(3);
    const maisRecente = lista.body[0];

    const off = await request(servidor())
      .post(
        `/api/expo-updates/admin/releases/${RUNTIME}/${maisRecente.nome}/desativar`,
      )
      .set('x-admin-token', ADMIN_TOKEN);
    expect(off.status).toBe(201);
    expect(off.body.ativa).toBe(false);

    const m = await manifestReq({});
    const manifest = JSON.parse(
      partesMultipart(m.headers['content-type'], texto(m)).find(
        (p) => p.nome === 'manifest',
      )!.corpo,
    );
    expect(manifest.launchAsset.url).toContain(`release=${lista.body[1].nome}`);

    const status = await request(servidor())
      .get('/api/expo-updates/admin/status')
      .set('x-admin-token', ADMIN_TOKEN);
    expect(status.body.assinaturaHabilitada).toBe(true);
    expect(status.body.urlPublica).toBe(URL_PUBLICA);
    expect(status.body.runtimes[0].ativa.nome).toBe(lista.body[1].nome);
  });
});
