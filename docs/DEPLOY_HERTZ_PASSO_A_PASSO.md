# Deploy Hertz — Passo a Passo

> Guia operacional para subir o backend da **Hertz** em VPS própria, com **MySQL instalado no host** (não em container).
>
> Complementa a análise em [CLONAGEM_BACKEND_HERTZ.md](CLONAGEM_BACKEND_HERTZ.md), que explica *por que* cada mudança foi feita.

---

## 1. O que mudou no código

A identidade do tenant deixou de ser literal e passou a vir do ambiente. **Um único código-base atende Mais Prime, Mais Prime RS, Hertz e futuras empresas** — a diferença entre deploys é só o `.env`.

### Núcleo novo

| Arquivo | Papel |
|---|---|
| `src/config/tenant.config.ts` | Fonte única de verdade: bases do deploy, derivação de nomes de env, branding |
| `src/config/is-tenant-base.validator.ts` | Valida `baseOrigin` em DTO contra as bases configuradas (substitui `@IsEnum`) |
| `src/config/tenant.config.spec.ts` | 16 testes, incluindo prova de que os nomes de env gerados são idênticos aos do mapa literal anterior |

### Pontos que deixaram de ser hardcoded

| Antes | Agora |
|---|---|
| `type BaseOrigin = 'MAIS_PRIME' \| 'MAIS_PRIME_RS'` | `BaseOrigin = string`, validado por `TENANT.baseNames` |
| `TOKEN_MAP` literal (28 entradas) | Gerado por `tenantEnvName(base, kind)` |
| 9 fallbacks `'MAIS_PRIME'` em SGA/boleto/rastreamento/revistoria | `TENANT.defaultBase` |
| Loops literais de 2 bases (M7, histórico M7, associado) | `TENANT.baseNames` |
| Mapa de envs M7 duplicado em `historico-m7.service.ts` | Removido — usa `tenantEnvName` |
| `enum UserBaseOrigin` no Prisma | `String @db.VarChar(50)` |
| `"Mais Prime App"`, e-mails `@maisprime.org.br` | `TENANT.appName`, `TENANT.mailPrevia`, `TENANT.mailCobranca` |
| Rodapé "sistema Mais Prime" (3 PDFs) | `TENANT.reportName` |
| `assets/Logo.png` fixo (3 PDFs) | `TENANT.logoPath` |
| URL de documentos `app-dev.texvngroup.com.br` | `TENANT.documentsBaseUrl` |

### Contrato com o frontend: inalterado

Isso foi tratado como requisito, não como consequência:

- **JWT**: mesmo payload, `baseOrigin` continua devolvendo `MAIS_PRIME`/`MAIS_PRIME_RS` no deploy atual.
- **`renovarTokenM7`**: continua retornando `{ MAIS_PRIME: {...}, MAIS_PRIME_RS: {...} }` — as chaves agora vêm de `TENANT.baseNames`, que resolve exatamente para esses valores.
- **`POST /auth/register`**: `baseOrigin` continua aceitando os mesmos valores e rejeitando os demais com 400.
- **Migration `baseOrigin`**: ENUM → VARCHAR preserva os rótulos como strings idênticas. A API devolve o mesmo valor de antes.
- **Defaults de branding**: sem nenhuma variável `TENANT_*` definida, a aplicação se comporta *exatamente* como antes (nome, e-mails, rodapé e URL de documentos originais). Isso está coberto por teste.

---

## 2. Aplicar no deploy atual (Mais Prime) — obrigatório

O código novo é compatível com o `.env` atual **sem nenhuma variável nova**, mas a migration do banco precisa ser aplicada.

```bash
git pull
npm ci
npx prisma generate
npx prisma migrate deploy     # aplica 20260727120000_base_origin_to_varchar
npm run build
# reiniciar o serviço
```

A migration roda `ALTER TABLE user MODIFY baseOrigin VARCHAR(50) NULL`. O MySQL converte os rótulos do ENUM nas mesmas strings — sem perda nem transformação de dados. Em tabela grande o `ALTER` faz cópia; rodar em janela de baixo tráfego.

> Se quiser deixar explícito no `.env` da Mais Prime (recomendado, evita depender do default):
> ```
> TENANT_BASES=MAIS_PRIME:,MAIS_PRIME_RS:_RS
> TENANT_DEFAULT_BASE=MAIS_PRIME
> TENANT_NAME=Mais Prime
> ```

---

## 3. Preparar o repositório antes de clonar

Os três bloqueadores da análise. O `.gitignore` já foi corrigido; falta commitar.

```bash
# 1. Migrations não versionadas — sem elas o banco novo não sobe
git add -f prisma/migrations/
git status --short prisma/migrations/   # confirmar as 7 migrations + migration_lock.toml

# 2. Payloads reais de webhook fora do versionamento
git rm -r --cached webhook/payloads

# 3. Documentação (a regra "*.md" ignorava docs/ inteiro — já ajustada)
git add docs/

git commit -m "chore: parametriza tenant por ambiente e corrige versionamento de migrations"
```

> `git rm --cached` remove do índice mas mantém os arquivos em disco. O histórico antigo ainda contém os payloads — por isso o repositório da Hertz deve nascer **sem histórico** (`git checkout --orphan` ou repo novo).

---

## 4. Subir a Hertz

### 4.1 MySQL no host da VPS

```sql
CREATE DATABASE hertz_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hertz_app'@'%' IDENTIFIED BY 'senha-forte';
GRANT ALL PRIVILEGES ON hertz_app.* TO 'hertz_app'@'%';
FLUSH PRIVILEGES;
```

**Ponto de atenção — a API roda em container e o MySQL no host.** Três ajustes que costumam travar o primeiro deploy:

1. `bind-address` do MySQL precisa aceitar a rede do Docker. Em `/etc/mysql/mysql.conf.d/mysqld.cnf`, usar o IP da bridge (`172.17.0.1`) ou `0.0.0.0`.
2. O container precisa resolver o host. No `docker-compose.yml`, no serviço `api`:
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
   e no `.env`: `DATABASE_URL=mysql://hertz_app:senha@host.docker.internal:3306/hertz_app`
3. **Firewall**: se o `bind-address` for `0.0.0.0`, bloquear a 3306 na borda (`ufw deny 3306`). Só a rede do Docker deve alcançar o banco.

### 4.2 `.env` da Hertz

Partir de [`.env.example`](../.env.example), que já está atualizado com todas as variáveis reais. O mínimo para subir:

```dotenv
TENANT_BASES=HERTZ
TENANT_DEFAULT_BASE=HERTZ
TENANT_REQUIRED_INTEGRATIONS=sga      # só SGA obrigatório enquanto as demais não estão contratadas
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
```

> `TENANT_REQUIRED_INTEGRATIONS=sga` é o que permite subir hoje sem ter ainda Softruck e Lógica. Conforme cada integração for contratada, acrescente (`sga,softruckPublicKey,logica`) para que a ausência de credencial derrube o boot em vez de falhar só quando um usuário acionar a feature.

### 4.3 Banco e seed

```bash
npx prisma migrate deploy
npx prisma generate

SEED_ADMIN_EMAIL=admin@hertz.com.br \
SEED_ADMIN_PASSWORD='senha-forte' \
SEED_ANDROID_STORE_URL='https://play.google.com/store/apps/details?id=com.hertz.app' \
npm run prisma:seed
```

O seed (`prisma/seed.ts`, novo) é idempotente e cria o usuário ADMIN do painel e as políticas de versão do app. Sem ele, ninguém entra no painel administrativo.

### 4.4 Logo e assets

Substituir `assets/Logo.png` pela logo da Hertz (usada nos 3 geradores de PDF), ou apontar `TENANT_LOGO_PATH` para outro arquivo.

### 4.5 Subir

```bash
docker compose up --build -d
curl http://localhost:3001/health
```

No boot, o log agora informa o tenant carregado:

```
[EnvValidator] Tenant: Hertz | bases=[HERTZ] | base padrão=HERTZ
```

Se esse log mostrar as bases erradas, o `.env` não chegou ao processo — ver 5.1.

---

## 5. Armadilhas conhecidas

### 5.1 A aplicação não carrega `.env` sozinha

Não há `dotenv` nem `ConfigModule` no projeto — `process.env` vem do ambiente. Consequências:

- **Docker Compose**: funciona, o `env_file: .env` já resolve.
- **Rodar local sem Docker**: `npm run start:dev` **vai falhar** no `validateEnvOrThrow()` porque nenhuma variável existe. Alternativas:
  ```bash
  npm run build && node --env-file=.env dist/main    # Node 20.6+
  ```
  ou exportar as variáveis na sessão antes de `npm run start:dev`.

Isso já era assim antes da parametrização — só passa a incomodar mais agora que há testes locais.

### 5.2 Redis exposto na internet

O `docker-compose.yml` publica `6379:6379` no host, sem senha. Numa VPS com IP público isso é acesso direto ao Redis. Trocar por:

```yaml
ports:
  - "127.0.0.1:6379:6379"
```
ou remover o mapeamento (a API alcança o Redis pela rede interna do compose).

### 5.3 Nginx e uploads

O limite de payload da API é 20 MB (fotos de revistoria em base64). Se houver proxy na frente, configurar `client_max_body_size 20m;` — senão uploads falham com 413.

### 5.4 Nominatim desligado

`M7_NOMINATIM_ENABLED=false` no `.env.example`. Ligar exige PostgreSQL + import de dados OSM na VPS, e os dados atuais são do RJ. Avaliar depois do go-live.

---

## 6. Estado da suíte de testes

`package.json` ganhou `moduleNameMapper` no jest — o alias `src/...` não resolvia, o que fazia 9 suítes falharem antes mesmo de executar.

| | Antes | Depois |
|---|---|---|
| Suítes falhando | 9 | 7 |
| Testes passando | 60 | 78 |

As 7 suítes que ainda falham são specs-scaffold (`should be defined`) que montam `Test.createTestingModule` sem declarar `PrismaService`/`SgaAuthService` como providers. É dívida pré-existente, sem relação com tenant — a falha de resolução de módulo apenas a mascarava. Vale limpar depois; não bloqueia o deploy.

---

## 7. Checklist do dia

- [ ] Migration aplicada no banco da **Mais Prime** e serviço reiniciado
- [ ] Migrations commitadas (`git add -f prisma/migrations/`)
- [ ] `webhook/payloads` removido do índice
- [ ] Repositório da Hertz criado sem histórico da Mais Prime
- [ ] MySQL do host acessível pelo container (`extra_hosts` + `bind-address` + firewall)
- [ ] `.env` da Hertz com segredos **novos** (`JWT_SECRET`, `ANALYTICS_SECRET`, `ADMIN_PANEL_TOKEN`)
- [ ] `prisma migrate deploy` em banco vazio
- [ ] Seed executado e login no painel validado
- [ ] Logo da Hertz em `assets/`
- [ ] Log de boot mostrando `Tenant: Hertz | bases=[HERTZ]`
- [ ] Redis não exposto publicamente
- [ ] Login de um associado real da base Hertz → JWT com `baseOrigin: HERTZ`
- [ ] Consulta de associado/veículo na Hinova respondendo

---

## 8. Como adicionar a próxima empresa

Depois desta refatoração, o custo passa a ser configuração — não código:

1. `TENANT_BASES=NOVA_EMPRESA` no `.env`
2. Preencher `USER_SGA_NOVA_EMPRESA`, `PASSWORD_SGA_NOVA_EMPRESA`, `TOKEN_BASE_SGA_NOVA_EMPRESA` e as credenciais das integrações contratadas
3. Trocar logo e variáveis `TENANT_*` de marca
4. `prisma migrate deploy` + seed

Nenhuma alteração em `schema.prisma`, em `token-resolver.service.ts` ou em qualquer serviço.
