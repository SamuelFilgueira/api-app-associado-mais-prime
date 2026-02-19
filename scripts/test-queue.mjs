/**
 * Script de teste de carga para a fila de notificações.
 *
 * Uso:
 *   node scripts/test-queue.mjs [quantidade] [endpoint]
 *
 * Exemplos:
 *   node scripts/test-queue.mjs          → 10 requisições via fila (/queue-test)
 *   node scripts/test-queue.mjs 20       → 20 requisições via fila
 *   node scripts/test-queue.mjs 10 test  → 10 requisições diretas (/test, sem fila)
 *
 * Resultado: exibe cada resposta com jobId, status HTTP e tempo de resposta.
 */

const TOTAL = parseInt(process.argv[2] ?? '10', 10);
const MODE  = process.argv[3] === 'test' ? 'test' : 'queue-test';
const BASE  = process.env.API_URL ?? 'http://localhost:3001/api';
const URL   = `${BASE}/notifications/${MODE}`;

const PAYLOAD = {
  userId: 2,
  expoPushToken: 'ExponentPushToken[BXGD2_AS9szb3pu_g9sd-v]',
  plate: 'T3ST65S',
  ignition: 'on',
  title: 'Teste de fila BullMQ',
  body: 'Verificando se a fila está processando jobs corretamente',
  ignitionOn: true,
  ignitionOff: false,
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const pad  = (n, len = 2) => String(n).padStart(len, ' ');
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

async function fireRequest(index) {
  const start = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...PAYLOAD, title: `${PAYLOAD.title} #${index + 1}` }),
    });
    const elapsed = Date.now() - start;
    const json = await res.json();

    const status = res.status === 200 || res.status === 201 ? green(`${res.status}`) : red(`${res.status}`);
    const jobInfo = json.jobId ? cyan(`jobId=${json.jobId}`) : red(JSON.stringify(json).slice(0, 80));
    console.log(`  [${pad(index + 1)}/${pad(TOTAL)}] ${status}  ${pad(elapsed, 4)}ms  ${jobInfo}`);
    return { success: res.ok, elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`  [${pad(index + 1)}/${pad(TOTAL)}] ${red('ERR')} ${pad(elapsed, 4)}ms  ${err.message}`);
    return { success: false, elapsed };
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

console.log();
console.log(bold('═══════════════════════════════════════════════'));
console.log(bold(` Teste de fila BullMQ — ${TOTAL} requisições`));
console.log(bold('═══════════════════════════════════════════════'));
console.log(` Endpoint : ${yellow(URL)}`);
console.log(` Modo     : ${MODE === 'queue-test' ? green('via fila (queue-test)') : yellow('direto (test, sem fila)')}`);
console.log(` Workers  : todas disparadas simultaneamente`);
console.log();

const globalStart = Date.now();
const results = await Promise.all(
  Array.from({ length: TOTAL }, (_, i) => fireRequest(i)),
);
const totalElapsed = Date.now() - globalStart;

const successes = results.filter((r) => r.success).length;
const failures  = TOTAL - successes;
const avgMs     = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / TOTAL);
const maxMs     = Math.max(...results.map((r) => r.elapsed));
const minMs     = Math.min(...results.map((r) => r.elapsed));

console.log();
console.log(bold('─── Resumo ─────────────────────────────────────'));
console.log(` Tempo total  : ${bold(totalElapsed + 'ms')}`);
console.log(` Sucesso      : ${green(String(successes))} / ${TOTAL}`);
console.log(` Falhas       : ${failures > 0 ? red(String(failures)) : '0'}`);
console.log(` Latência     : min=${minMs}ms  avg=${avgMs}ms  max=${maxMs}ms`);
console.log();

if (MODE === 'queue-test') {
  console.log(yellow(' → Acompanhe os logs do servidor para ver os jobs sendo processados'));
  console.log(yellow('   pelo NotificationProcessor (prefixo [QUEUE]):'));
  console.log(cyan('   npm run start:dev'));
  console.log();
}
