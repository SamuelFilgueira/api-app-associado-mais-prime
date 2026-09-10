#!/usr/bin/env node
/**
 * Publica uma atualização OTA (JS/assets) no servidor self-hosted de expo-updates
 * desta API. Sem dependências — usa só Node >= 18 e o zip do sistema.
 *
 * Rodar a partir da RAIZ DO PROJETO DO APP (onde está o app.json):
 *
 *   node caminho/para/publicar-update.mjs --api https://api.suaempresa.com.br --token $ADMIN_PANEL_TOKEN
 *
 * Opções:
 *   --api <url>              Base da API (sem /api). Ou env OTA_API_URL
 *   --token <token>          ADMIN_PANEL_TOKEN. Ou env OTA_ADMIN_TOKEN
 *   --runtime-version <v>    Default: lido de dist/expoConfig.json (string ou policy appVersion)
 *   --descricao "<texto>"    Descrição livre do release (aparece na listagem)
 *   --platform all|android|ios   Default: all
 *   --dist <pasta>           Pasta de saída do export. Default: ./dist
 *   --skip-export            Não roda `npx expo export`, só zipa e envia --dist
 *   --dry-run                Gera o zip mas não envia
 *
 * Passos executados:
 *   1. npx expo export --platform <p> --output-dir <dist>
 *   2. zip do conteúdo de <dist> (metadata.json na raiz do zip)
 *   3. POST <api>/api/expo-updates/admin/publicar (multipart: arquivo, runtimeVersion, descricao)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// ─── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (nome, valorDefault) => {
  const i = args.indexOf(nome);
  if (i === -1) return valorDefault;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const tem = (nome) => args.includes(nome);

const API = String(flag('--api', process.env.OTA_API_URL ?? '')).replace(/\/+$/, '');
const TOKEN = String(flag('--token', process.env.OTA_ADMIN_TOKEN ?? ''));
const PLATFORM = String(flag('--platform', 'all'));
const DIST = resolve(String(flag('--dist', 'dist')));
const DESCRICAO = flag('--descricao', '');
const SKIP_EXPORT = tem('--skip-export');
const DRY_RUN = tem('--dry-run');
let runtimeVersion = flag('--runtime-version', null);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function falhar(msg) {
  console.error(red(`\n✖ ${msg}`));
  process.exit(1);
}

function rodar(cmd, cmdArgs, opts = {}) {
  console.log(yellow(`$ ${cmd} ${cmdArgs.join(' ')}`));
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) falhar(`Comando falhou: ${cmd} ${cmdArgs.join(' ')}`);
}

if (!DRY_RUN && (!API || !TOKEN)) {
  falhar('Informe --api e --token (ou OTA_API_URL / OTA_ADMIN_TOKEN). Use --dry-run para só gerar o zip.');
}
if (!['all', 'android', 'ios'].includes(PLATFORM)) {
  falhar('--platform deve ser all, android ou ios');
}

// ─── 1. export ───────────────────────────────────────────────────────────────

if (!SKIP_EXPORT) {
  if (!existsSync('app.json') && !existsSync('app.config.js') && !existsSync('app.config.ts')) {
    falhar('Rode este script na raiz do projeto do app (app.json não encontrado). Ou use --skip-export com --dist.');
  }
  rmSync(DIST, { recursive: true, force: true });
  // "all" no Expo inclui web (exige react-native-web) — listar só as plataformas nativas
  const plataformas = PLATFORM === 'all' ? ['android', 'ios'] : [PLATFORM];
  rodar('npx', [
    'expo',
    'export',
    ...plataformas.flatMap((p) => ['--platform', p]),
    '--output-dir',
    DIST,
  ]);
}

const metadataPath = join(DIST, 'metadata.json');
if (!existsSync(metadataPath)) {
  falhar(`metadata.json não encontrado em ${DIST}. O export falhou?`);
}

// ─── 2. expoConfig.json + runtimeVersion ─────────────────────────────────────

// SDK 52+ não grava mais expoConfig.json no export. Geramos a partir da config
// pública do projeto: o servidor coloca esse JSON em `extra.expoClient` do
// manifest, que é de onde `Constants.expoConfig` sai quando o app roda um update.
const cfgPath = join(DIST, 'expoConfig.json');
if (!existsSync(cfgPath) && existsSync('app.json')) {
  console.log(yellow('$ npx expo config --type public --json'));
  const r = spawnSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CI: '1' },
  });
  const inicioJson = r.stdout?.indexOf('{') ?? -1;
  if (r.status === 0 && inicioJson >= 0) {
    writeFileSync(cfgPath, r.stdout.slice(inicioJson).trim());
  } else {
    console.log(yellow('Não foi possível obter a config pública do Expo; seguindo sem expoConfig.json'));
  }
}

if (!runtimeVersion) {
  if (!existsSync(cfgPath)) {
    falhar('Não foi possível determinar o runtimeVersion; informe --runtime-version (igual ao app.json)');
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const rv = cfg.runtimeVersion;
  if (typeof rv === 'string') {
    runtimeVersion = rv;
  } else if (rv && typeof rv === 'object' && rv.policy === 'appVersion' && cfg.version) {
    runtimeVersion = cfg.version;
  } else {
    falhar(
      `Não foi possível resolver runtimeVersion a partir de expoConfig.json (${JSON.stringify(rv)}). ` +
        'Informe --runtime-version com o MESMO valor embutido no binário nativo.',
    );
  }
}

const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const plataformas = Object.keys(metadata.fileMetadata ?? {});
console.log(`\n${bold('Runtime version:')} ${runtimeVersion}`);
console.log(`${bold('Plataformas:')}     ${plataformas.join(', ') || red('nenhuma!')}`);

// ─── 3. zip ──────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'ota-publish-'));
const zipPath = join(tmp, `update-${runtimeVersion}-${Date.now()}.zip`);

/** Confere a assinatura "PK" — GNU tar aceita `-a ... .zip` e gera um TAR comum. */
function ehZipValido(caminho) {
  if (!existsSync(caminho) || statSync(caminho).size < 4) return false;
  const magic = readFileSync(caminho).subarray(0, 2).toString('latin1');
  return magic === 'PK';
}

function tentarBsdtar() {
  // bsdtar (tar.exe no Windows 10+, macOS, maioria das distros) gera zip com "/".
  // Ele interpreta "C:" em -f como host remoto → usar nome relativo com cwd.
  // No Windows, dentro do Git Bash o `tar` do PATH é o GNU → usar o do System32.
  const bin =
    process.platform === 'win32' && process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'tar.exe')
      : 'tar';
  if (process.platform === 'win32' && !existsSync(bin)) return false;

  const r = spawnSync(bin, ['-a', '-cf', basename(zipPath), '-C', DIST, '.'], {
    cwd: tmp,
    stdio: 'pipe',
  });
  if (r.status === 0 && ehZipValido(zipPath)) return true;
  rmSync(zipPath, { force: true });
  return false;
}

function zipar() {
  if (tentarBsdtar()) return;

  if (process.platform === 'win32') {
    console.log(yellow('tar.exe indisponível, usando Compress-Archive'));
    rodar('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path "${DIST}\\*" -DestinationPath "${zipPath}" -Force`,
    ]);
  } else {
    rodar('zip', ['-r', '-q', zipPath, '.'], { cwd: DIST });
  }
  if (!ehZipValido(zipPath)) falhar('Não foi possível gerar um zip válido');
}

zipar();
const tamanhoMb = (statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`${bold('Zip:')}             ${tamanhoMb} MB`);
console.log(`ZIP_PATH=${zipPath}`);

if (DRY_RUN) {
  console.log(green('\n✔ dry-run: zip gerado, nada enviado.'));
  process.exit(0);
}

// ─── 4. upload ───────────────────────────────────────────────────────────────

const form = new FormData();
form.append('runtimeVersion', runtimeVersion);
if (DESCRICAO && DESCRICAO !== true) form.append('descricao', String(DESCRICAO));
form.append('arquivo', new Blob([readFileSync(zipPath)], { type: 'application/zip' }), 'dist.zip');

console.log(`\n${bold('Enviando para')} ${API}/api/expo-updates/admin/publicar ...`);
const inicio = Date.now();
let res;
try {
  res = await fetch(`${API}/api/expo-updates/admin/publicar`, {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
    body: form,
  });
} catch (err) {
  falhar(`Falha de rede: ${err.message}`);
}

const texto = await res.text();
let corpo;
try {
  corpo = JSON.parse(texto);
} catch {
  corpo = texto;
}

rmSync(tmp, { recursive: true, force: true });

if (!res.ok) {
  console.error(corpo);
  falhar(`Servidor respondeu ${res.status}`);
}

console.log(green(`\n✔ Release publicado em ${((Date.now() - inicio) / 1000).toFixed(1)}s`));
console.log(`  runtimeVersion: ${corpo.runtimeVersion}`);
console.log(`  release:        ${corpo.nome}`);
console.log(`  plataformas:    ${corpo.plataformas?.join(', ')}`);
console.log(`  tamanho:        ${corpo.tamanhoMb} MB`);
console.log(
  `\nRollback, se precisar:\n  curl -X POST -H "x-admin-token: ..." ${API}/api/expo-updates/admin/releases/${corpo.runtimeVersion}/<release-anterior>/republicar`,
);
