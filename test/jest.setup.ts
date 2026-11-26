/**
 * Isola a suíte do `.env` da máquina.
 *
 * O Prisma Client gerado carrega o `.env` da raiz no momento em que é
 * importado (sem sobrescrever o que já está definido). Qualquer spec que
 * importe `PrismaService` herdava então o tenant, as URLs e as credenciais do
 * `.env` local — com `TENANT_BASES=HERTZ` na máquina, por exemplo, os testes
 * que usam a base `MAIS_PRIME` falhavam só ali.
 *
 * Aqui o client é importado uma vez, antes do spec, e tudo o que essa
 * importação acrescentou ao ambiente é removido. As variáveis que o próprio
 * shell/CI definiu ficam como estão.
 */
const antes = new Set(Object.keys(process.env));

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@prisma/client');

for (const chave of Object.keys(process.env)) {
  if (!antes.has(chave)) delete process.env[chave];
}
