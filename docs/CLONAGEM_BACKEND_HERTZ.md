# Clonagem do Backend para a Hertz — Visão Geral

> **Documento mestre**: o que já está pronto e o que ainda falta para subir o backend na infraestrutura da Hertz.
>
> - Comandos detalhados do deploy: **[DEPLOY_HERTZ_PASSO_A_PASSO.md](DEPLOY_HERTZ_PASSO_A_PASSO.md)**
> - Lado mobile (lojas, push, branding do app): **[CLONAGEM_APP_WHITE_LABEL_OUTRA_EMPRESA.md](CLONAGEM_APP_WHITE_LABEL_OUTRA_EMPRESA.md)**
>
> Última atualização: 2026-07-28

---

## Sumário

1. [Situação atual](#1-situação-atual)
2. [O que já está pronto](#2-o-que-já-está-pronto)
3. [O que falta — visão geral](#3-o-que-falta--visão-geral)
4. [Frente A — Fechar o repositório](#frente-a--fechar-o-repositório)
5. [Frente B — Aplicar na Mais Prime](#frente-b--aplicar-na-mais-prime-produção)
6. [Frente C — Credenciais das integrações](#frente-c--credenciais-das-integrações)
7. [Frente D — Repositório da Hertz](#frente-d--repositório-da-hertz)
8. [Frente E — Infraestrutura da VPS](#frente-e--infraestrutura-da-vps)
9. [Frente F — Banco e seed](#frente-f--banco-e-seed)
10. [Frente G — Marca](#frente-g--marca)
11. [Decisões pendentes](#11-decisões-pendentes)
12. [Riscos ainda abertos](#12-riscos-ainda-abertos)
13. [Checklist consolidado](#13-checklist-consolidado)
14. [Apêndice — por que a arquitetura ficou assim](#14-apêndice--por-que-a-arquitetura-ficou-assim)

---

## 1. Situação atual

A refatoração de multi-tenant está concluída e **já roda em produção na Mais Prime** desde 2026-07-28. O código não tem mais nenhuma identidade de empresa embutida: as bases, as credenciais e a marca vêm do ambiente.

```
[ CÓDIGO ]      concluído e em produção ✅
[ REPOSITÓRIO ] commitado; histórico de migrations rebaselinado ✅
[ MAIS PRIME ]  atualizada em produção ✅
[ INTEGRAÇÕES ] credenciais da Hertz obtidas ✅
[ INFRA VPS ]   VPS da Hertz disponível ✅
[ MARCA ]       logo e textos disponíveis ✅
[ BASELINE PROD ] registrar 0_init em prod ⬜
[ CLONE HERTZ ] pendente ⬜
[ BANCO HERTZ ] pendente ⬜
```

O que restou é execução: registrar o baseline em produção e criar o ambiente da Hertz.

---

## 2. O que já está pronto

### 2.1 Parametrização do tenant

`src/config/tenant.config.ts` passou a ser a fonte única da identidade do tenant. Um único código-base atende Mais Prime, Mais Prime RS, Hertz e futuras empresas — a diferença entre deploys é o `.env`.

| Antes | Agora |
|---|---|
| `type BaseOrigin = 'MAIS_PRIME' \| 'MAIS_PRIME_RS'` | `BaseOrigin = string`, validado por `TENANT.baseNames` |
| `TOKEN_MAP` literal (28 entradas) | Gerado por `tenantEnvName(base, kind)` |
| 9 fallbacks `'MAIS_PRIME'` em SGA/boleto/rastreamento/revistoria | `TENANT.defaultBase` |
| Loops literais de 2 bases (M7, histórico M7, associado) | `TENANT.baseNames` |
| Mapa de envs M7 duplicado em `historico-m7.service.ts` | Removido — usa `tenantEnvName` |
| `enum UserBaseOrigin` no Prisma | `String @db.VarChar(50)` |
| `"Mais Prime App"` e e-mails `@maisprime.org.br` | `TENANT.appName`, `TENANT.mailPrevia`, `TENANT.mailCobranca` |
| Rodapé "sistema Mais Prime" (3 PDFs) | `TENANT.reportName` |
| `assets/Logo.png` fixo (3 PDFs) | `TENANT.logoPath` |
| URL de documentos `app-dev.texvngroup.com.br` hardcoded | `TENANT.documentsBaseUrl` |

Arquivos novos: `src/config/tenant.config.ts`, `src/config/is-tenant-base.validator.ts`, `src/config/tenant.config.spec.ts`, `prisma/seed.ts`, `prisma/migrations/20260727120000_base_origin_to_varchar/`.

### 2.2 Contrato com o frontend: preservado

Tratado como requisito, não como consequência. Sem nenhuma variável `TENANT_*` no `.env`, o comportamento é idêntico ao anterior — há teste cobrindo isso.

- JWT com mesmo payload; `baseOrigin` continua devolvendo `MAIS_PRIME`/`MAIS_PRIME_RS`
- `renovarTokenM7` continua retornando `{ MAIS_PRIME: {...}, MAIS_PRIME_RS: {...} }`
- `POST /auth/register` aceita e rejeita exatamente os mesmos valores
- ENUM → VARCHAR preserva os rótulos como strings idênticas

### 2.3 Validação executada (2026-07-27, ambiente de testes local)

| Verificação | Resultado |
|---|---|
| Migration aplicada no banco local | `baseOrigin` = `varchar(50)`; 48 usuários `MAIS_PRIME` + 5 `MAIS_PRIME_RS` preservados |
| Boot | `Tenant: Mais Prime \| bases=[MAIS_PRIME, MAIS_PRIME_RS] \| base padrão=MAIS_PRIME` |
| M7 — `POST /api/rastreamento/renovar-token` | Token obtido nas **duas** bases contra a API real; chaves da resposta inalteradas |
| SGA — `GET /api/associado/verificar-situacao/:cpf` | Cada base resolveu sua própria credencial: `USER_SGA_MAIS_PRIME` vs `USER_SGA_MAIS_PRIME_RS` |
| Testes | 78 passando (eram 60); 7 suítes-scaffold falhando por dívida pré-existente |
| Build | `dist/main.js` no caminho original, compatível com `start:prod` e Dockerfile |
| Erros no log | Zero |

### 2.4 Correções de apoio

- `.gitignore`: liberou `docs/` (a regra `*.md` ignorava a documentação inteira) e passou a bloquear `webhook/payloads`
- `.env.example`: reescrito — faltavam ~20 variáveis reais
- `package.json`: `moduleNameMapper` no jest — o alias `src/...` não resolvia e derrubava 9 suítes antes de executar
- `tsconfig.build.json`: exclui `prisma/seed.ts`, que senão mudava o output para `dist/src/main.js`
- `prisma/migrations/`: rebaselinado em `0_init` — o histórico anterior criava só 14 das 25 tabelas (ver Frente A.1)

---

## 3. O que falta — visão geral

| Frente | O quê | Estado |
|---|---|---|
| **A** | Repositório: migrations rebaselinadas, payloads e docs ajustados | ✅ concluída |
| **B** | Produção Mais Prime atualizada | ✅ concluída — falta só registrar o baseline (B.1) |
| **C** | Credenciais das integrações | ✅ obtidas |
| **D** | Criar repositório da Hertz sem histórico | ⬜ pendente |
| **E** | VPS, MySQL no host, proxy, TLS | ✅ VPS disponível — falta configurar |
| **F** | `migrate deploy` + seed no banco da Hertz | ⬜ pendente |
| **G** | Logo e textos da marca | ✅ disponíveis |

**Próximos passos, em ordem:** B.1 (baseline em prod) → D (clone) → F (banco) → validação local → VPS da Hertz.

---

## Frente A — Repositório ✅ concluída

### A.1 Migrations versionadas e rebaselinadas

O histórico anterior **não reproduzia o schema**: as 7 migrations criavam 14 tabelas, sendo 5 delas (`Consent`, `Session`, `Offer`, `Partner`, `ServiceItem`) inexistentes no schema atual. Faltavam 16, entre elas `UserVehicle`, `FuelSession`, todas as `Reinspection*` e todas as `Analytics*`.

Versionar aquele histórico teria sido inútil — ele quebraria em produção (`CREATE TABLE User` numa tabela existente) e geraria schema incompleto em banco novo.

**Correção aplicada**: as 7 migrations foram movidas para `prisma/migrations-legacy/` e substituídas por um único `prisma/migrations/0_init/`, gerado do schema real.

Validado em banco descartável com `prisma migrate deploy`: **25 tabelas, `baseOrigin varchar(50)`, 9 foreign keys**.

### A.2 Payloads reais fora do versionamento

`webhook/payloads/*.json` continha placas, chassis e coordenadas de associados reais. O `.gitignore` passou a bloqueá-los.

### A.3 Documentação versionada

A regra `*.md` do `.gitignore` ignorava `docs/` inteiro. Corrigida, mantendo as notas soltas da raiz ignoradas.

---

## Frente B — Produção Mais Prime ✅ concluída em 2026-07-28

O diagnóstico do banco de produção revelou duas diferenças em relação ao schema:

| Item | Estado encontrado | Ação |
|---|---|---|
| `baseOrigin` | `enum('MAIS_PRIME','MAIS_PRIME_RS')` | `ALTER ... VARCHAR(50)` |
| Tabelas | 25 (faltava `NotificationPopup`) | `CREATE TABLE` da migration correspondente |

Ambas aplicadas via `prisma db execute`, com backup prévio. Dados preservados: **6.839 `MAIS_PRIME` + 373 `MAIS_PRIME_RS`**, idênticos antes e depois.

Deploy feito com `docker compose up -d --build api`. Log de subida:

```
[EnvValidator] Tenant: Mais Prime | bases=[MAIS_PRIME, MAIS_PRIME_RS] | base padrão=MAIS_PRIME
[EnvValidator] Environment variables validated
```

Nenhuma variável de ambiente nova foi necessária.

### B.1 Pendente — registrar o baseline

Único item aberto na Mais Prime. Faz o `migrate deploy` voltar a ser seguro:

```bash
git pull

npx prisma db execute --schema prisma/schema.prisma --stdin <<'EOF'
DELETE FROM _prisma_migrations;
EOF

npx prisma migrate resolve --applied 0_init
npx prisma migrate status     # "Database schema is up to date!"
```

`_prisma_migrations` é tabela de controle do Prisma — apagá-la não toca em dado de negócio. Não precisa rebuildar o container.

> Enquanto isso não for feito, **ninguém pode rodar `npx prisma migrate deploy` nessa VPS** — travaria o pipeline.

---

## Frente C — Credenciais das integrações ✅ obtidas

Referência dos nomes de env que cada credencial ocupa no `.env` da Hertz.

| Integração | O que obter | Envs (base única `HERTZ`) |
|---|---|---|
| **SGA / Hinova** | Base da Hertz + usuário de API | `USER_SGA_HERTZ`, `PASSWORD_SGA_HERTZ`, `TOKEN_BASE_SGA_HERTZ` |
| **M7** | Código e token da conta Hertz | `MO7_TOKEN`, `M07_CODIGO`, `M7_API_BASE_URL`, `M7_WEBHOOK_TOKEN` |
| **Lógica Soluções** | Token e número da conta | `LOGICA_TOKEN`, `LOGICA_API_BASE_URL`, `LOGICA_API_NUMBER` |
| **Softruck** | Usuário, senha, chave pública | `USERNAME_SOFTRUCK`, `PASSWORD_SOFTRUCK`, `PUBLIC_KEY_SOFTRUCK`, `SOFTRUCK_TOKEN` |
| **Alloyal / Lecupon** | Business ID + CNPJ da Hertz | `API_SECRET_ALLOYAL`, `ALLOYAL_BUSINESS_ID`, `ALLOYAL_BUSINESS_CNPJ`, `x_clientemployee_*` |
| **Clubgas** | Token da conta | `TOKEN_API_CLUBGAS` |
| **Suri (WhatsApp)** | Canal + templates aprovados | `suri_baseUrl`, `token_suri`, `suri_template_id*`, `channelId`, `sendTo` |
| **AWS SES** | Domínio verificado da Hertz | `MAIL_FROM`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| **Expo Push** | Projeto Expo/Firebase/APNs da Hertz | ver doc de white label mobile |

**Não é preciso ter tudo para subir.** `TENANT_REQUIRED_INTEGRATIONS=sga` permite iniciar só com o SGA; conforme cada integração entrar, acrescente à lista (`sga,softruckPublicKey,logica`) para que a ausência de credencial derrube o boot em vez de falhar só quando um usuário acionar a feature.

### Segredos que devem ser gerados novos (não reaproveitar)

| Env | Se reaproveitado |
|---|---|
| `JWT_SECRET` | Token da Mais Prime autentica na API da Hertz |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Idem |
| `ANALYTICS_SECRET` | Permite correlacionar usuários entre as empresas (é chave HMAC) |
| `ADMIN_PANEL_TOKEN` | Acesso administrativo cruzado |
| `M7_WEBHOOK_TOKEN` | Webhook de uma empresa aceito pela outra |

```bash
openssl rand -base64 48
```

---

## Frente D — Repositório da Hertz

Criar **sem o histórico da Mais Prime** (`git checkout --orphan` ou repositório novo com commit inicial). O histórico contém os payloads reais da seção A.2 e não tem valor operacional para a nova empresa.

> Se a intenção for manter código realmente compartilhado, a alternativa melhor é um único repositório *core* com dois ambientes (`.env` diferentes) em vez de dois repositórios. A parametrização já suporta isso — a decisão é organizacional.

---

## Frente E — Infraestrutura da VPS

### E.1 MySQL no host (decisão já tomada: fora de container)

```sql
CREATE DATABASE hertz_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hertz_app'@'%' IDENTIFIED BY 'senha-forte';
GRANT ALL PRIVILEGES ON hertz_app.* TO 'hertz_app'@'%';
FLUSH PRIVILEGES;
```

Três ajustes que costumam travar o primeiro deploy, porque a API roda em container e o banco no host:

1. `bind-address` do MySQL precisa aceitar a rede do Docker — IP da bridge (`172.17.0.1`) ou `0.0.0.0`
2. `extra_hosts: ["host.docker.internal:host-gateway"]` no serviço `api` do compose, e `DATABASE_URL` apontando para `host.docker.internal`
3. **Firewall**: se usar `bind-address=0.0.0.0`, bloquear a 3306 na borda (`ufw deny 3306`)

### E.2 Demais componentes

| Item | Situação |
|---|---|
| **Redis** | Já no compose. **Trocar `6379:6379` por `127.0.0.1:6379:6379`** — hoje fica exposto na internet sem senha |
| **Nginx / Caddy** | Não existe no repo. Provisionar com TLS e `client_max_body_size 20m` (senão upload de revistoria falha com 413) |
| **Chromium** | Já resolvido no Dockerfile |
| **Recursos** | Mínimo sugerido 4 vCPU / 8 GB — o Puppeteer dos PDFs é o maior consumidor |
| **Backup** | Incluir os volumes `uploads-data` e `webhook-data`, além do dump do MySQL |
| **Healthcheck da API** | Só o Redis tem; vale adicionar um contra `/health` |

### E.3 Carregamento do `.env`

A aplicação **não** carrega `.env` sozinha — não há `dotenv` nem `ConfigModule`. Via Docker Compose o `env_file` resolve. Fora do Docker, use `node --env-file=.env dist/main` (Node 20.6+) ou exporte as variáveis.

---

## Frente F — Banco e seed

Com o rebaseline da Frente A, o `migrate deploy` num banco vazio cria as **25 tabelas** corretamente — validado em banco descartável.

```bash
npx prisma migrate deploy     # aplica 0_init
npx prisma generate

SEED_ADMIN_EMAIL=admin@hertz.com.br \
SEED_ADMIN_PASSWORD='senha-forte' \
SEED_ANDROID_STORE_URL='https://play.google.com/store/apps/details?id=com.hertz.app' \
npm run prisma:seed
```

O seed é idempotente e cria o usuário ADMIN do painel e as políticas de versão do app. **Sem ele ninguém entra no painel administrativo** — banco limpo não é banco vazio.

Nada de dados da Mais Prime deve ser migrado: nenhum `user`, `userVehicle`, `Notification`, boleto, revistoria, arquivo de `uploads/` ou payload de webhook.

---

## Frente G — Marca

- Substituir `assets/Logo.png` pela logo da Hertz (usada nos 3 geradores de PDF) ou apontar `TENANT_LOGO_PATH`
- Definir `TENANT_NAME`, `TENANT_APP_NAME`, `TENANT_REPORT_NAME`
- Definir `MAIL_TO_PREVIA` e `MAIL_TO_COBRANCA` — **os defaults ainda são os e-mails da Mais Prime**
- Atualizar `package.json` (`name`) e o `README.md`, que ainda é o boilerplate do NestJS

---

## 11. Decisões pendentes

| # | Decisão | Contexto |
|---|---|---|
| 1 | **Nominatim ligado ou desligado?** | Reverse geocode próprio exige PostgreSQL + import OSM (dezenas de GB) e os dados atuais são do RJ — a Hertz pode operar em outra UF. Sugestão: começar com `M7_NOMINATIM_ENABLED=false` |
| 2 | **Repositórios separados ou core compartilhado?** | A parametrização suporta os dois; separado volta a criar divergência com o tempo |
| 3 | **Bases da Hertz** | Uma só (`HERTZ`) ou várias filiais na Hinova? Define `TENANT_BASES` |
| 4 | **Guard no `renovar-token`** | `POST /api/rastreamento/renovar-token` está sem nenhum guard e dispara login nas APIs externas de todas as bases. Foi útil para validar, mas em produção convém o `AdminTokenGuard` |
| 5 | **CORS** | Hoje `origin: true` aceita qualquer origem; vale restringir aos domínios do app/painel da Hertz |

### 11.1 Regra que passa a valer (não é decisão, é disciplina)

Foi a ausência disso que quebrou o histórico de migrations.

**Nunca `prisma db push` em banco que importa.** Só em banco descartável.

Toda mudança de schema nasce de uma migration, localmente:

```bash
# edita prisma/schema.prisma
npx prisma migrate dev --name adiciona_campo_x
git add prisma/migrations/ prisma/schema.prisma && git commit
```

> No MySQL o `migrate dev` precisa de um *shadow database* temporário. Se o usuário do banco não tiver permissão de `CREATE DATABASE`, configure `shadowDatabaseUrl` no datasource.

E o deploy ganha uma etapa:

```bash
git pull
npx prisma migrate status     # confere ANTES
npx prisma migrate deploy
docker compose up -d --build api
```

> Não coloque `migrate deploy` no Dockerfile nem em entrypoint: com mais de uma réplica, os containers competem para aplicar a mesma migration.

---

## 12. Riscos ainda abertos

| # | Risco | Mitigação |
|---|---|---|
| 1 | **`migrate deploy` na VPS da Mais Prime antes do baseline** → migration marcada como *failed*, pipeline travado | Frente B.1 — enquanto não for feita, ninguém roda `migrate deploy` lá |
| 2 | Voltar a usar `db push` e quebrar o histórico de novo | Toda mudança de schema via `migrate dev` + commit da migration |
| 3 | Dados da Mais Prime no repo da Hertz | Repositório da Hertz sem histórico (Frente D) |
| 4 | Segredo reaproveitado entre empresas | `JWT_SECRET`, `ANALYTICS_SECRET`, `ADMIN_PANEL_TOKEN`, `M7_WEBHOOK_TOKEN` novos |
| 5 | Credencial de integração faltando só falha quando o usuário aciona a feature | `TENANT_REQUIRED_INTEGRATIONS` cobrindo o que já foi contratado |
| 6 | Redis exposto na internet na VPS nova | Frente E.2 |
| 7 | Redis compartilhado entre os dois projetos na validação local | Instância separada (`REDIS_PORT=6380`) — não há prefixo de chave nem índice de DB |
| 8 | Rodar local sem Docker e o boot abortar por falta de env | Frente E.3 |
| 9 | Usuário sem `baseOrigin` → login lança 500 | Garantir que o primeiro acesso preencha `baseOrigin` |
| 10 | 7 suítes de teste falhando (scaffold sem providers) | Dívida pré-existente; não bloqueia, mas vale limpar |

---

## 13. Checklist consolidado

### Repositório
- [x] Migrations rebaselinadas em `0_init`
- [x] `webhook/payloads` fora do versionamento
- [x] `docs/` versionado
- [ ] Repositório da Hertz criado sem histórico da Mais Prime

### Mais Prime (produção)
- [x] `NotificationPopup` criada e `baseOrigin` convertida para `VARCHAR(50)`
- [x] Código novo em produção (`docker compose up -d --build api`)
- [ ] **Baseline registrado** (`migrate resolve --applied 0_init`) — Frente B.1
- [ ] Login, rastreamento e boleto validados nas duas bases

### Integrações
- [x] Credenciais da Hertz obtidas
- [ ] `JWT_SECRET`, `ANALYTICS_SECRET`, `ADMIN_PANEL_TOKEN`, `M7_WEBHOOK_TOKEN` gerados novos
- [ ] `TENANT_REQUIRED_INTEGRATIONS` refletindo o que já existe

### Infra
- [ ] MySQL no host acessível pelo container (`bind-address` + `extra_hosts` + firewall)
- [ ] Redis não exposto publicamente
- [ ] Reverse proxy com TLS e `client_max_body_size 20m`
- [ ] Backup de MySQL + volumes `uploads-data` e `webhook-data`
- [ ] Decisão sobre Nominatim tomada

### Banco
- [ ] `prisma migrate deploy` em banco vazio
- [ ] Seed executado e login no painel validado
- [ ] Zero dados da Mais Prime

### Marca
- [ ] Logo da Hertz em `assets/`
- [ ] `TENANT_NAME` / `TENANT_APP_NAME` / `TENANT_REPORT_NAME`
- [ ] `MAIL_TO_PREVIA` e `MAIL_TO_COBRANCA` trocados

### Validação final
- [ ] Log de boot mostrando `Tenant: Hertz | bases=[HERTZ]`
- [ ] `/health` respondendo com `database: ok`
- [ ] Login de associado real → JWT com `baseOrigin: HERTZ`
- [ ] Consulta de associado/veículo na Hinova
- [ ] Rastreamento nos provedores contratados
- [ ] Geração de PDF (valida Puppeteer + logo nova)
- [ ] Push notification ponta a ponta
- [ ] Upload de foto e acesso via `/uploads`
- [ ] Painel administrativo acessível

---

## 14. Apêndice — por que a arquitetura ficou assim

### 14.1 O eixo do tenant é `baseOrigin`

```
Login → AuthService.login() lê user.baseOrigin do banco
      → grava baseOrigin no payload do JWT
      → BaseContextService (REQUEST-scoped) lê request.user.baseOrigin
      → TokenResolverService traduz baseOrigin em NOMES de variáveis de ambiente
      → cada integração externa usa a credencial da base correta
```

**O tenant não separa dados, separa credenciais de APIs externas.** Todos os usuários convivem na mesma tabela `user`, no mesmo banco. O que muda por base é com qual conta da Hinova/M7/Softruck/Alloyal a API vai falar.

Como a Hertz terá VPS e banco próprios, ela não precisa conviver com `MAIS_PRIME` no mesmo processo — o deploy dela declara suas próprias bases.

### 14.2 Por que parametrizar em vez de forkar

Antes da refatoração, a identidade do tenant estava espalhada por ~40 pontos em 15 arquivos. Um fork bruto seria mais rápido no primeiro deploy, mas criaria divergência permanente: toda correção precisaria ser portada manualmente entre repositórios.

Os motivos concretos para parametrizar foram:

1. A arquitetura já estava 80% pronta — `TokenResolverService` e `BaseContextService` já isolavam credenciais por base; faltava tirar os literais de dentro deles.
2. Já havia dívida de duplicação: `historico-m7.service.ts` mantinha um segundo mapa de envs M7 paralelo ao `TOKEN_MAP`. Um fork duplicaria essa dívida.
3. O grupo tende a crescer — o custo do fork é linear na quantidade de empresas; o da parametrização é constante.

### 14.3 Por que o enum do Prisma virou `String`

O `enum UserBaseOrigin` obrigava uma migration de schema a cada nova empresa, gerando divergência num arquivo versionado. Com `VARCHAR(50)`, as bases válidas passaram a ser definidas por ambiente e validadas na aplicação (`isTenantBase`), mantendo um único `schema.prisma` para todos os deploys.

### 14.4 Como adicionar a próxima empresa

1. `TENANT_BASES=NOVA_EMPRESA` no `.env`
2. Preencher `USER_SGA_NOVA_EMPRESA`, `PASSWORD_SGA_NOVA_EMPRESA`, `TOKEN_BASE_SGA_NOVA_EMPRESA` e as credenciais das integrações contratadas
3. Trocar logo e variáveis `TENANT_*` de marca
4. `prisma migrate deploy` + seed

Nenhuma alteração em `schema.prisma`, em `token-resolver.service.ts` ou em qualquer serviço.
