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

A refatoração de multi-tenant **está concluída e validada localmente**. O código não tem mais nenhuma identidade de empresa embutida: as bases, as credenciais e a marca vêm do ambiente.

O que sobrou é trabalho de **repositório, infraestrutura, credenciais e dados** — não de código.

```
[ CÓDIGO ]      concluído e validado ✅
[ REPOSITÓRIO ] pendente — nada commitado ainda ⬜
[ MAIS PRIME ]  pendente — migration não aplicada em produção ⬜
[ INTEGRAÇÕES ] pendente — depende de contratos com terceiros ⬜
[ INFRA VPS ]   pendente ⬜
[ BANCO HERTZ ] pendente ⬜
```

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

---

## 3. O que falta — visão geral

Ordem sugerida. As frentes A e C podem correr em paralelo; **C é a que tem lead time externo e deve começar primeiro**.

| Frente | O quê | Depende de | Bloqueia o go-live? |
|---|---|---|---|
| **A** | Commitar migrations, remover payloads do índice | — | Sim |
| **B** | Aplicar migration na produção Mais Prime | A | Não (mas é obrigatório antes de subir o código novo lá) |
| **C** | Contratar/obter credenciais das integrações | terceiros | Sim |
| **D** | Criar repositório da Hertz sem histórico | A | Sim |
| **E** | Provisionar VPS, MySQL no host, proxy, TLS | — | Sim |
| **F** | `migrate deploy` + seed no banco da Hertz | D, E | Sim |
| **G** | Logo e textos da marca | — | Não (cosmético) |

---

## Frente A — Fechar o repositório

**Estado verificado em 2026-07-28: nada commitado ainda.** Apenas 2 das 7 migrations estão versionadas e os 39 arquivos de `webhook/payloads` continuam no índice.

### A.1 Versionar as migrations — crítico

Sem isso, `prisma migrate deploy` no banco da Hertz não consegue criar o schema do zero.

| Migration | Versionada? |
|---|---|
| `20250909152028_init` | ❌ |
| `20260119123248_add_notification_model` | ❌ |
| `202607140001_app_version_gate` | ✅ |
| `20260715000000_add_admin_panel_user` | ❌ |
| `20260720113000_add_marketing_notification_audit_log` | ✅ |
| `20260721000000_add_notification_popup` | ❌ |
| `20260727120000_base_origin_to_varchar` | ❌ (nova) |
| `migration_lock.toml` | ❌ |

```bash
git add -f prisma/migrations/
git status --short prisma/migrations/   # conferir as 7 + o lock
```

> O `-f` é necessário só porque parte dessas pastas já era ignorada historicamente. Confira o `git status` antes de commitar.

### A.2 Tirar os payloads reais do versionamento

`webhook/payloads/*.json` contém placas, chassis e coordenadas de associados reais da Mais Prime. O `.gitignore` já bloqueia novos arquivos, mas os 39 existentes seguem rastreados.

```bash
git rm -r --cached webhook/payloads
```

Remove do índice mantendo os arquivos em disco.

### A.3 Versionar a documentação

```bash
git add docs/
git commit -m "chore: parametriza tenant por ambiente, versiona migrations e docs"
```

---

## Frente B — Aplicar na Mais Prime (produção)

O código novo funciona com o `.env` atual **sem nenhuma variável nova**, mas a migration precisa ser aplicada antes de subir.

```bash
git pull && npm ci
npx prisma generate
npx prisma migrate deploy     # aplica 20260727120000_base_origin_to_varchar
npm run build
# reiniciar o serviço
```

Roda `ALTER TABLE user MODIFY baseOrigin VARCHAR(50) NULL`. Sem perda nem transformação de dados — já validado no ambiente de testes. Em tabela grande o MySQL faz cópia; **executar em janela de baixo tráfego**.

Opcional, mas recomendado, para não depender dos defaults:

```dotenv
TENANT_BASES=MAIS_PRIME:,MAIS_PRIME_RS:_RS
TENANT_DEFAULT_BASE=MAIS_PRIME
TENANT_NAME=Mais Prime
```

---

## Frente C — Credenciais das integrações

**Comece por aqui.** Cada item depende de contrato ou cadastro com terceiros e tem prazo que você não controla.

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

```bash
npx prisma migrate deploy
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

---

## 12. Riscos ainda abertos

| # | Risco | Mitigação |
|---|---|---|
| 1 | Clonar sem as migrations → banco novo não sobe | Frente A.1 antes de qualquer clone |
| 2 | Dados da Mais Prime no repo da Hertz | Frente A.2 + repositório sem histórico |
| 3 | Segredo reaproveitado entre empresas | Frente C — gerar novos |
| 4 | Credencial de integração faltando só falha quando o usuário aciona a feature | `TENANT_REQUIRED_INTEGRATIONS` cobrindo o que já foi contratado |
| 5 | Redis exposto na internet na VPS nova | Frente E.2 |
| 6 | Migration em produção travando tabela grande | Janela de baixo tráfego (Frente B) |
| 7 | Rodar local sem Docker e o boot abortar por falta de env | Frente E.3 |
| 8 | Usuário sem `baseOrigin` → login lança 500 | Garantir que o primeiro acesso preencha `baseOrigin` |
| 9 | 7 suítes de teste falhando (scaffold sem providers) | Dívida pré-existente; não bloqueia, mas vale limpar |

---

## 13. Checklist consolidado

### Repositório
- [ ] `git add -f prisma/migrations/` — 7 migrations + `migration_lock.toml`
- [ ] `git rm -r --cached webhook/payloads`
- [ ] `git add docs/` e commit
- [ ] Repositório da Hertz criado sem histórico da Mais Prime

### Mais Prime (produção)
- [ ] `prisma migrate deploy` aplicado em janela de baixo tráfego
- [ ] Serviço reiniciado com o código novo
- [ ] Login, rastreamento e boleto validados nas duas bases

### Integrações
- [ ] Credenciais obtidas para cada integração contratada (Frente C)
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
