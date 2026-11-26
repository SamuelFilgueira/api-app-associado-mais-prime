# Testes do beneficios-api

Como a suíte está organizada, como rodar cada camada e o que vale (e o que não vale) simular.

## Camadas

| Camada | O que cobre | Onde fica | Com o quê |
|---|---|---|---|
| Unidade de domínio | Regra pura: janelas da régua, máquina de estados da revistoria, parsers, mapeadores | `src/**/domain/*.spec.ts` | Jest puro. Relógio e aleatoriedade entram por parâmetro; sem mock |
| Unidade de aplicação | Caso de uso contra as portas | `src/**/*.spec.ts` | Fakes das portas (fila, push, cache, vendor), não mock de método |
| Contrato HTTP | Formato das respostas, congelado antes de refatorar | `src/**/*.contract.spec.ts` | supertest com o controller real; guards sobrescritos |
| Segurança | Quem pode chamar o quê: sem token, token de outro associado, token do painel | `src/**/*.seguranca.spec.ts` | supertest com `JwtAuthGuard` e `JwtStrategy` **reais** |
| Integração | Trava, lease, unique, script Lua, fila, `SKIP LOCKED` | `test/integracao/*.integration-spec.ts` | MariaDB e Redis **reais**, descartáveis |
| Carga | Abertura do app, polling de posição, PDFs simultâneos | `test/carga/*.js` | k6 contra homologação com vendors simulados |

## Como rodar

```bash
npm test                      # unidade, contrato e segurança (não precisa de banco nem Redis)
npx jest src/sga --silent     # um módulo
npx jest -t "nome do teste"
npm run verify                # typecheck + testes + build
```

### Integração

Os testes de integração precisam de um MariaDB e de um Redis. Sem as variáveis abaixo, as suítes são
**puladas** (não falham), então `npm test` continua funcionando em qualquer máquina.

```bash
# Serviços descartáveis (portas só em loopback)
docker run -d --name beneficios-teste-db -e MARIADB_ROOT_PASSWORD=teste -e MARIADB_DATABASE=beneficios_teste \
  -p 127.0.0.1:3317:3306 mariadb:11.8
docker run -d --name beneficios-teste-redis -p 127.0.0.1:6390:6379 redis:7-alpine redis-server --save "" --appendonly no

# Esquema
DATABASE_URL="mysql://root:teste@127.0.0.1:3317/beneficios_teste" npx prisma migrate deploy

# Suíte
TEST_DATABASE_URL="mysql://root:teste@127.0.0.1:3317/beneficios_teste" \
TEST_REDIS_URL="redis://127.0.0.1:6390/1" \
npm run test:integration
```

No CI (`.github/workflows/ci.yml`) os dois sobem como service containers e as variáveis já vêm
definidas.

Regras para quem escreve teste de integração:

- use um marcador próprio (`it-<assunto>-${process.pid}`) nas linhas e chaves que criar e apague só o
  que criou; nunca `deleteMany()` sem filtro nem `FLUSHDB`;
- o apoio fica em `test/integracao/ambiente.ts` (`describeComBanco`, `describeComRedis`,
  `redisDeTeste`, `limparChaves`).

### PDF com Chromium de verdade

```bash
TEST_PDF=1 npx jest src/infra/pdf
```

Fora isso o renderizador é testado com um navegador de mentira (o CI não baixa o Chromium).

### Carga

Ver `test/carga/README.md`. Só contra homologação, com os vendors simulados
(`HINOVA_SGA_BASE_URL` e as demais URLs de vendor apontando para o simulador). Nunca contra produção.

## O que vale simular

Vendors HTTP (Hinova, M7, Lógica, Softruck, ClubGas, Alloyal), Expo, e-mail, storage, relógio e
aleatoriedade.

## O que NÃO vale simular

- **O banco.** Fake de transação não reproduz isolamento, deadlock, timeout nem violação de unique.
  Trava, lease e índice único são testados contra o MariaDB (`test/integracao`).
- **Redis e BullMQ.** Mock de ioredis não executa os scripts Lua; mock de fila não reproduz retry,
  `jobId` duplicado nem job repetível.
- **Guards e `ValidationPipe`** nos testes de segurança. Os contract specs sobrescrevem os guards — por
  isso nenhum deles pegou as rotas que estavam abertas. O spec de segurança usa o guard real.

## O ambiente de teste é isolado do `.env`

O Prisma Client carrega o `.env` da raiz no momento em que é importado. `test/jest.setup.ts` desfaz
isso antes de cada arquivo de teste: a suíte não herda tenant, URLs nem credenciais do `.env` da
máquina. Variável definida no shell ou no CI continua valendo.

## Apoios

| Arquivo | Para quê |
|---|---|
| `src/infra/auth/testing/jwt-de-teste.ts` | `AUTENTICACAO_DE_TESTE`, `tokenDoApp`, `tokenDoPainel`, `bearer`, `clienteHttp` |
| `src/infra/redis/testing/redis-em-memoria.ts` | Redis mínimo (GET/SET/DEL/MGET) para unidade de cache e sessão |
| `src/associado-sorte/testing/sorte-tx.memoria.ts` | Dublê da unidade de trabalho do Associado da Sorte |
| `test/fixtures/` | Respostas sanitizadas do SGA |

## Antes de refatorar

1. Escreva o teste de caracterização do que existe (o que devolve, o que chama).
2. Mude.
3. `npm run verify` verde e os contract specs sem alteração de expectativa.
