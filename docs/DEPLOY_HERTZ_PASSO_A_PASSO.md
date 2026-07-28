# Deploy Hertz — Passo a Passo

> Guia operacional para subir o backend da **Hertz** com **MySQL instalado no host** (não em container).
>
> Contexto e decisões: [CLONAGEM_BACKEND_HERTZ.md](CLONAGEM_BACKEND_HERTZ.md)
>
> Última atualização: 2026-07-28

---

## 1. Estado atual

| Item | Situação |
|---|---|
| Parametrização de tenant | ✅ Concluída e em produção |
| Produção Mais Prime | ✅ Atualizada em 2026-07-28 |
| Histórico de migrations | ✅ Rebaseline feito — `0_init` reproduz o schema real |
| Clone da Hertz | ⬜ Pendente |

---

## 2. O que mudou no código

`src/config/tenant.config.ts` é a fonte única da identidade do tenant. Um único código-base atende Mais Prime, Mais Prime RS, Hertz e futuras empresas — a diferença entre deploys é o `.env`.

| Antes | Agora |
|---|---|
| `type BaseOrigin = 'MAIS_PRIME' \| 'MAIS_PRIME_RS'` | `BaseOrigin = string`, validado por `TENANT.baseNames` |
| `TOKEN_MAP` literal (28 entradas) | Gerado por `tenantEnvName(base, kind)` |
| 9 fallbacks `'MAIS_PRIME'` | `TENANT.defaultBase` |
| Loops literais de 2 bases | `TENANT.baseNames` |
| Mapa de envs M7 duplicado | Removido — usa `tenantEnvName` |
| `enum UserBaseOrigin` no Prisma | `String @db.VarChar(50)` |
| `"Mais Prime App"` e e-mails fixos | `TENANT.appName`, `TENANT.mailPrevia`, `TENANT.mailCobranca` |
| Rodapé "sistema Mais Prime" (3 PDFs) | `TENANT.reportName` |
| `assets/Logo.png` fixo | `TENANT.logoPath` |
| URL de documentos hardcoded | `TENANT.documentsBaseUrl` |

**Contrato com o frontend preservado.** Sem nenhuma variável `TENANT_*`, o comportamento é idêntico ao anterior — coberto por teste. JWT com mesmo payload, `renovarTokenM7` com as mesmas chaves, `POST /auth/register` aceitando os mesmos valores.

---

## 3. Histórico de migrations — o que foi corrigido

O histórico anterior **não reproduzia o schema**: as 7 migrations criavam 14 tabelas, sendo 5 delas (`Consent`, `Session`, `Offer`, `Partner`, `ServiceItem`) inexistentes no schema atual. Faltavam 16, entre elas `UserVehicle`, `FuelSession`, todas as `Reinspection*` e todas as `Analytics*`.

Isso causava dois problemas:

- Em produção, `prisma migrate deploy` tentaria `CREATE TABLE User` numa tabela existente → erro 1050 → migration marcada como *failed*, travando todos os deploys seguintes.
- Num banco novo, geraria um schema incompleto.

**Correção aplicada**: as 7 migrations foram movidas para `prisma/migrations-legacy/` e substituídas por um único `prisma/migrations/0_init/`, gerado a partir do schema real:

```bash
npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

Validado em banco descartável: **25 tabelas, `baseOrigin varchar(50)`, 9 foreign keys**.

### 3.1 Registrar o baseline em produção (Mais Prime)

Só precisa ser feito **uma vez**. O banco já tem o schema, então a migration é registrada **sem ser executada**:

```bash
git pull

npx prisma db execute --schema prisma/schema.prisma --stdin <<'EOF'
DELETE FROM _prisma_migrations;
EOF

npx prisma migrate resolve --applied 0_init
npx prisma migrate status     # deve dizer "Database schema is up to date!"
```

`_prisma_migrations` é tabela de controle do Prisma — apagá-la não toca em dado de negócio. Faça backup mesmo assim.

Não precisa rebuildar o container: o Prisma Client é gerado do `schema.prisma`, não dessa tabela.

---

## 4. Subir a Hertz

### 4.1 MySQL no host

```sql
CREATE DATABASE hertz_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hertz_app'@'%' IDENTIFIED BY 'senha-forte';
GRANT ALL PRIVILEGES ON hertz_app.* TO 'hertz_app'@'%';
FLUSH PRIVILEGES;
```

Como a API roda em container e o banco no host, três ajustes costumam travar o primeiro deploy:

1. `bind-address` do MySQL aceitando a rede do Docker — IP da bridge (`172.17.0.1`) ou `0.0.0.0`
2. No serviço `api` do compose:
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
   e `DATABASE_URL` apontando para `host.docker.internal`
3. **Firewall**: com `bind-address=0.0.0.0`, bloquear a 3306 na borda (`ufw deny 3306`)

### 4.2 `.env` da Hertz

Partir de [`.env.example`](../.env.example). O mínimo:

```dotenv
TENANT_BASES=HERTZ
TENANT_DEFAULT_BASE=HERTZ
TENANT_REQUIRED_INTEGRATIONS=sga
TENANT_NAME=Hertz

DATABASE_URL=mysql://hertz_app:senha@host.docker.internal:3306/hertz_app
REDIS_HOST=redis
APP_URL=https://api-hertz.seudominio.com.br

JWT_SECRET=<openssl rand -base64 48>
ANALYTICS_SECRET=<openssl rand -base64 48>
ADMIN_PANEL_TOKEN=<openssl rand -base64 32>

USER_SGA_HERTZ=
PASSWORD_SGA_HERTZ=
TOKEN_BASE_SGA_HERTZ=

MAIL_TO_PREVIA=previa@hertz.com.br
MAIL_TO_COBRANCA=cobranca@hertz.com.br

M7_NOMINATIM_ENABLED=false
```

Com base única e sem sufixo, as envs de integração ficam **sem sufixo**: `MO7_TOKEN`, `LOGICA_TOKEN`, `PUBLIC_KEY_SOFTRUCK`. Só o SGA usa o nome da base.

> `TENANT_REQUIRED_INTEGRATIONS=sga` permite subir sem ter todas as integrações. Conforme cada uma entrar, acrescente (`sga,softruckPublicKey,logica`) para que a falta de credencial derrube o boot em vez de falhar quando um usuário acionar a feature.

### 4.3 Banco e seed

```bash
npx prisma migrate deploy     # aplica 0_init: cria as 25 tabelas
npx prisma generate

SEED_ADMIN_EMAIL=admin@hertz.com.br \
SEED_ADMIN_PASSWORD='senha-forte' \
SEED_ANDROID_STORE_URL='https://play.google.com/store/apps/details?id=com.hertz.app' \
npm run prisma:seed
```

O seed é idempotente e cria o ADMIN do painel e as políticas de versão do app. **Sem ele ninguém entra no painel** — banco limpo não é banco vazio.

### 4.4 Logo

Substituir `assets/Logo.png` pela logo da Hertz (usada nos 3 geradores de PDF) ou apontar `TENANT_LOGO_PATH`.

### 4.5 Subir

```bash
docker compose up -d --build api
curl http://localhost:3001/health
```

Log esperado:

```
[EnvValidator] Tenant: Hertz | bases=[HERTZ] | base padrão=HERTZ
```

---

## 5. Validação local antes da VPS

Para validar na sua máquina, ao lado do projeto da Mais Prime, três coisas precisam ser isoladas:

```dotenv
PORT=3002
REDIS_PORT=6380
DATABASE_URL=mysql://USUARIO:SENHA@localhost:3306/hertz_local
```

```bash
docker run -d --name redis-hertz -p 6380:6379 redis:7-alpine
node --env-file=.env dist/main
```

> **Redis precisa ser separado.** `queue.module.ts` e `analytics-redis.provider.ts` leem só `REDIS_HOST`/`REDIS_PORT`, sem índice de DB e sem prefixo de chave. No mesmo Redis, os nomes de fila são idênticos e um job da Hertz pode ser processado pelo worker da Mais Prime.

Roteiro de validação:

| # | O quê | Prova |
|---|---|---|
| 1 | `GET /health` | Banco conectado |
| 2 | `POST /api/rastreamento/renovar-token` | Credencial M7 da Hertz. Deve retornar **só a chave `HERTZ`** |
| 3 | `GET /api/associado/verificar-situacao/<CPF>` | Credencial SGA/Hinova da Hertz |
| 4 | `POST /api/associado/primeiro-acesso` | Ponta a ponta: cria o primeiro usuário da Hinova |
| 5 | `POST /api/auth/login` | JWT com `baseOrigin: "HERTZ"` |
| 6 | `POST /api/rastreamento/ultima-posicao` | Resolução de credencial por requisição |
| 7 | Gerar um PDF | Puppeteer + logo nova |

No log, confirme `[BASE:HERTZ] resolved token key USER_SGA_HERTZ`.

---

## 6. Fluxo de schema daqui pra frente

Foi a ausência disso que quebrou o histórico. A regra:

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

> Não coloque `migrate deploy` dentro do Dockerfile ou de um entrypoint. Com mais de uma réplica, os containers competem para aplicar a mesma migration. Mantenha como passo explícito do script de deploy.

---

## 7. Armadilhas conhecidas

### 7.1 A aplicação não carrega `.env` sozinha

Não há `dotenv` nem `ConfigModule`. Via Docker Compose o `env_file` resolve. Fora do Docker: `node --env-file=.env dist/main` (Node 20.6+) ou exportar as variáveis.

### 7.2 Redis exposto na internet

O compose publica `6379:6379` no host, sem senha. Trocar por `127.0.0.1:6379:6379` ou remover o mapeamento.

### 7.3 Nginx e uploads

Limite de payload da API é 20 MB (fotos de revistoria em base64). Configurar `client_max_body_size 20m;` no proxy, senão uploads falham com 413.

### 7.4 `renovar-token` sem guard

`POST /api/rastreamento/renovar-token` não tem nenhum guard e dispara login nas APIs externas de todas as bases. Útil para validação, mas em produção convém o `AdminTokenGuard`.

### 7.5 Nominatim

`M7_NOMINATIM_ENABLED=false` por padrão. Ligar exige PostgreSQL + import OSM (dezenas de GB) e os dados atuais são do RJ.

---

## 8. Estado da suíte de testes

`package.json` ganhou `moduleNameMapper` no jest — o alias `src/...` não resolvia e derrubava 9 suítes antes de executar.

| | Antes | Depois |
|---|---|---|
| Suítes falhando | 9 | 7 |
| Testes passando | 60 | 78 |

As 7 restantes são specs-scaffold (`should be defined`) que montam `Test.createTestingModule` sem declarar `PrismaService`/`SgaAuthService` como providers. Dívida pré-existente, sem relação com tenant.

---

## 9. Checklist da Hertz

- [ ] Baseline registrado em produção Mais Prime (seção 3.1)
- [ ] Repositório da Hertz criado sem histórico da Mais Prime
- [ ] MySQL do host acessível pelo container
- [ ] `.env` com segredos **novos** (`JWT_SECRET`, `ANALYTICS_SECRET`, `ADMIN_PANEL_TOKEN`)
- [ ] Redis não exposto publicamente
- [ ] `prisma migrate deploy` em banco vazio → 25 tabelas
- [ ] Seed executado e login no painel validado
- [ ] Logo da Hertz em `assets/`
- [ ] Log de boot mostrando `Tenant: Hertz | bases=[HERTZ]`
- [ ] Roteiro da seção 5 completo

---

## 10. Como adicionar a próxima empresa

1. `TENANT_BASES=NOVA_EMPRESA` no `.env`
2. Preencher `USER_SGA_NOVA_EMPRESA`, `PASSWORD_SGA_NOVA_EMPRESA`, `TOKEN_BASE_SGA_NOVA_EMPRESA` e as credenciais contratadas
3. Trocar logo e variáveis `TENANT_*` de marca
4. `prisma migrate deploy` + seed

Nenhuma alteração em `schema.prisma`, em `token-resolver.service.ts` ou em qualquer serviço.
