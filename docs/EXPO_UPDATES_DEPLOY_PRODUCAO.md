# OTA em produção — plano de deploy passo a passo

Plano para colocar o servidor de atualizações OTA (`src/expo-updates`) em
produção na VPS da Mais Prime (MAIS_PRIME + MAIS_PRIME_RS) e liberar o primeiro
binário do app que consome essas atualizações.

Referência técnica do módulo: `docs/EXPO_UPDATES_OTA.md`. Arquitetura vigente e
regras de dependência: `docs/ARQUITETURA_ALVO_2026-09.md`. Este documento é só
a sequência de execução e os cuidados.

> **Atualizado em 2026-09-10.** O deploy que leva o OTA para a VPS **não é um
> deploy isolado do módulo**: a árvore de trabalho atual contém também a
> refatoração arquitetural de 2026-09-09 (guards em `infra/`, `HinovaModule`,
> submódulos de rastreamento), a migration `20260827142258_analytics_journey`
> e a rotina de notificação de boletos. Tudo isso sobe junto no mesmo
> `git pull`. A seção 2 trata esse deploy como o que ele é: um deploy da API
> inteira, com migration.

---

## Visão geral da ordem

```
0. Fechar o repositório         (commits, verify, boot local)              ← novo
1. Chaves de produção           (máquina local, 5 min)
2. API na VPS                   (backup, migration, .env, deploy, smoke)   ← ampliado
3. App: config de produção      (app.json + prebuild, 15 min)
4. Build nativo + lojas         (Play Console + App Store, dias de revisão)
5. Primeiro OTA                 (só depois que o binário novo estiver nas lojas)
6. Rotina                       (publicar, verificar, rollback)
```

A API pode ir antes do app: enquanto nenhum binário tiver a URL compilada, os
endpoints de update não são chamados. O que exige cuidado nesse deploy é a
refatoração e a migration, não o OTA.

---

## 0. Fechar o repositório

Estado em 2026-09-10: ~130 arquivos modificados e ~29 novos **sem commit**
desde `4aacfea`. Nada disso está na VPS.

### 0.1 Validar a árvore inteira

```bash
npm run verify          # typecheck + jest + build
```

Resultado em 2026-09-10: `tsc` limpo, 219 testes passando, build ok.

A refatoração mudou a ligação dos módulos do Nest (`HinovaModule` deixou de
ser global; guards mudaram de pasta). Erro de injeção de dependência **só
aparece no boot**, não no `tsc` nem no jest. Por isso, antes de commitar,
subir a API a partir do build com o `.env` local e confirmar:

```bash
npm run build
node --env-file=.env dist/main
# em outro terminal
curl http://localhost:3001/health
```

Esperado: `{"status":"ok", ..., "checks":{"database":"ok"}}`, log com
`Nest application successfully started`, nenhum `Nest can't resolve
dependencies`, e as rotas `/api/expo-updates/*` listadas pelo `RouterExplorer`.
Feito em 2026-09-10 com sucesso. Os únicos warnings foram
`PUPPETEER_EXECUTABLE_PATH` e `CLUBGAS_BASE_URL` ausentes, ambos com default
no código (o primeiro é definido pelo Dockerfile; o segundo tem fallback em
`clubgas.client.ts`).

### 0.2 Commitar em blocos

Um commit por assunto facilita rollback parcial e leitura do histórico:

1. `refactor: guards em infra/, HinovaModule, submódulos de rastreamento` (a
   movimentação de 2026-09-09, sem lógica).
2. `feat(analytics): jornada do usuário` (schema + migration `analytics_journey`
   + processor). **A pasta da migration está untracked; confirme que ela entrou
   no commit**, senão o `migrate deploy` na VPS não a encontra.
3. `feat(expo-updates): servidor OTA self-hosted` (`src/expo-updates/`,
   `scripts/publicar-update.mjs`, `docs/EXPO_UPDATES_*`, `Dockerfile`,
   `docker-compose.yml`, `.env.example`, `.gitignore`, `package.json` com
   `adm-zip`, `CLAUDE.md`).
4. O que sobrar (boleto-notificação, docs).

`git push` e anotar o hash final: é o alvo do `git pull` na VPS e o ponto de
retorno em caso de rollback.

### 0.3 Conferir compliance do módulo OTA com a arquitetura

Checklist da seção 8 de `ARQUITETURA_ALVO_2026-09.md`, já atendido:

- `process.env` só em `src/expo-updates/config/expo-updates.config.ts`
  (config do módulo) e classificado em `env.validator.ts` como opcional.
- Nenhum import de outro domínio: `AdminTokenGuard` vem de
  `src/infra/guards/` e não é redeclarado como provider.
- Controllers só validam e delegam; filesystem e zip ficam em
  `ExpoUpdatesReleasesService` (adaptador).
- Sem Prisma, sem fila, sem REQUEST scope. Não toca em god service.

---

## 1. Chaves de produção (local)

Gere um par **novo** para produção. O par do teste local circulou por máquina
de desenvolvimento e túnel; não reaproveite.

```bash
cd /c/AppAssociadoNewDesign/AppAssociado
npx expo-updates codesigning:generate \
  --key-output-directory keys \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name "Mais Prime"
```

- `certs/certificate.pem` → **commitar** no repo do app (é público, vai no binário).
- `keys/private-key.pem` → **nunca commitar**. `keys/` no `.gitignore` do app.

Guarde a chave privada em dois lugares fora da máquina (cofre de senhas da
empresa e backup offline). **Se ela for perdida, nenhum app instalado aceita
mais OTA**; a saída é build novo nas lojas com certificado novo. Se vazar,
quem a tiver empurra código para todos os aparelhos: gere par novo e force
atualização nativa pelo `app-version` gate.

Uma linha, formato do `.env` da VPS:

```bash
base64 -w0 keys/private-key.pem
```

---

## 2. API na VPS

### 2.1 Backup do banco

A migration `analytics_journey` altera `AnalyticsSummaryReceipt` (coluna nova
com default) e cria três tabelas. É aditiva, mas backup é obrigatório antes de
qualquer `migrate deploy`:

```bash
mysqldump -u <user> -p beneficiosdb > backup-$(date +%Y%m%d-%H%M).sql
```

### 2.2 `.env` de produção

Adicionar:

```bash
EXPO_UPDATES_PRIVATE_KEY_BASE64=<saída do base64 acima, uma linha>
# só se o app chamar a API por host diferente de APP_URL:
# EXPO_UPDATES_PUBLIC_URL=https://api.maisprime.com.br
```

Conferir o que já existe:

- `APP_URL` com `https://` e o domínio que o app usa (base das URLs dos
  assets; sem HTTPS o iOS recusa).
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` (o Dockerfile define, mas o
  validador avisa se faltar no `.env`).
- `CLUBGAS_BASE_URL` é opcional (fallback no código). Definir só para
  silenciar o warning.

### 2.3 Reverse proxy

O zip de publicação tem 10 a 30 MB. Na rota da API no Nginx:

```nginx
client_max_body_size 200m;
```

### 2.4 Deploy

Sequência da doc de deploy existente, com a migration como passo explícito
(nunca no Dockerfile nem em entrypoint):

```bash
cd /caminho/beneficios-api
git pull
git log --oneline -1                 # confirmar que é o hash anotado em 0.2

npx prisma migrate status            # deve listar 20260827142258_analytics_journey como pendente
npx prisma migrate deploy
npx prisma migrate status            # "Database schema is up to date!"

docker compose up -d --build api
```

Se o `migrate status` mostrar uma migration **falhada** de deploy anterior,
pare e resolva antes (ver `DEPLOY_HERTZ_PASSO_A_PASSO.md`, seção sobre
`_prisma_migrations`). Não force.

O `docker-compose.yml` monta `updates-data:/app/updates`; os releases OTA
sobrevivem a rebuilds.

### 2.5 Smoke pós-deploy

O boot é o momento em que a refatoração se prova. Verificar nesta ordem:

```bash
docker compose logs api --tail=200 | grep -E "ERROR|can't resolve|successfully started|code signing"
```

- Deve haver `Nest application successfully started`.
- **Não** deve haver `Nest can't resolve dependencies` (módulo esquecendo
  `imports: [HinovaModule]`, por exemplo).
- **Não** deve haver `Code signing DESABILITADO`.

Depois, um request por área que a refatoração tocou:

| Área | Request | Esperado |
|---|---|---|
| Health | `GET /health` | `status: ok`, `database: ok` |
| Auth (guards movidos) | `POST /api/auth/login` com usuário de teste | 200 e JWT |
| Hinova via `HinovaModule` | `GET /api/boletos` (ou rota equivalente) com o JWT | 200 e lista |
| Rastreamento (submódulos) | `POST /api/rastreamento` com cnpj/chassi de teste | 200 com posição |
| `AdminTokenGuard` em `infra/` | `GET /api/expo-updates/admin/status` com `x-admin-token` | `assinaturaHabilitada: true`, `runtimes: []` |
| Notificações admin | qualquer rota admin de notificações com `x-admin-token` | 200 |
| Analytics (migration) | `POST /api/analytics/...` do app de teste | 201, sem erro de tabela |

Um 401 inesperado em rota com JWT ou `x-admin-token` aponta para guard movido
sem import atualizado. Um 500 com `Unknown column` ou `Table doesn't exist`
aponta para migration não aplicada.

### 2.6 Rollback da API

```bash
git checkout <hash anterior>       # 4aacfea, se for o caso
docker compose up -d --build api
```

A migration `analytics_journey` é aditiva: o código antigo ignora as tabelas e
a coluna novas. **Não reverta a migration** no rollback; não é necessário e o
Prisma não tem `down` automático.

---

## 3. App: configuração de produção

### 3.1 `app.json`

```jsonc
{
  "expo": {
    "version": "1.3.0",          // nova versão de loja
    "runtimeVersion": "1.3.0",   // SEMPRE igual ao version
    "updates": {
      "enabled": true,
      "url": "https://api.maisprime.com.br/api/expo-updates/manifest",
      "checkAutomatically": "ON_LOAD",
      "fallbackToCacheTimeout": 0,
      "codeSigningCertificate": "./certs/certificate.pem",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
    }
  }
}
```

Remover o que era só do teste local: o plugin `expo-build-properties` com
`usesCleartextTraffic: true` e qualquer URL `trycloudflare.com`.

### 3.2 Aplicar no nativo

```bash
npx expo prebuild --platform android
```

Conferir no diff de `android/`:

- `AndroidManifest.xml`: `EXPO_UPDATE_URL` com a URL de produção, **sem**
  `android:usesCleartextTraffic="true"`;
- `strings.xml`: `expo_runtime_version` = `1.3.0`;
- `build.gradle`: `versionCode` incrementado e `versionName` = `1.3.0` (o
  prebuild pode ter sobrescrito o ajuste manual; refaça se preciso).

Para iOS o `eas build` aplica o `app.json` sozinho.

### 3.3 Commit e tag

```bash
git add app.json certs/certificate.pem android/
git commit -m "build: 1.3.0 com expo-updates self-hosted"
git tag build-1.3.0
```

Todo OTA futuro para o runtime `1.3.0` sai de um commit descendente dessa tag,
sem mudança nativa (seção 7).

---

## 4. Build nativo e lojas

Mesmo fluxo de hoje:

```bash
# Android
cd android && rm -rf app/.cxx && ./gradlew bundleRelease --no-daemon
# → subir o .aab no Play Console

# iOS
eas build --platform ios --profile production
eas submit --platform ios
# → criar a release no App Store Connect e aguardar revisão
```

Enquanto as lojas revisam, **não publique OTA para `1.3.0`**. O build que o
revisor da Apple testa baixaria o OTA, e o que foi revisado deixaria de ser o
que está no binário. Publique só com o app disponível para download.

Binários antigos (`1.2.4` e anteriores) seguem funcionando como sempre: não
têm a URL compilada e nunca chamam a API de updates.

---

## 5. Primeiro OTA em produção

Só quando `1.3.0` estiver publicado nas duas lojas.

Antes, valide o mesmo `dist/` no ambiente local (API local + túnel + APK de
release, o fluxo já executado em 2026-09-09). Não há rollout gradual: um
release vale para 100% dos aparelhos do runtime na próxima abertura.

Na raiz do app:

```bash
node /c/Users/leuma/Desktop/Projetos/App-associado/beneficios-api/scripts/publicar-update.mjs \
  --api https://api.maisprime.com.br \
  --token "$ADMIN_PANEL_TOKEN_PRODUCAO" \
  --descricao "1.3.0 — <o que mudou>"
```

O script exporta android e ios, obtém a config pública com `expo config`
(o SDK 55 não gera mais `expoConfig.json`), resolve o `runtimeVersion`, zipa
e envia. Depois:

```bash
curl -H "x-admin-token: ..." "https://api.maisprime.com.br/api/expo-updates/admin/releases?runtimeVersion=1.3.0"
```

No log da API, `GET /api/expo-updates/manifest 200` seguido de
`GET /api/expo-updates/assets 200` indica aparelhos baixando.

---

## 6. Rotina de publicação

Checklist por OTA:

1. **A mudança é só JS/assets?** Se tocou em algo nativo (seção 7), pare: é
   build de loja.
2. Commit descendente da tag `build-<runtime>`.
3. Testar o mesmo commit localmente com APK de release do mesmo runtime.
4. Publicar com o script, `--descricao` identificando o commit.
5. Verificar `admin/releases` e o log da API.
6. Abrir o app em um aparelho da equipe duas vezes e confirmar.

Rollback (aparelhos voltam na próxima abertura):

```bash
curl -H "x-admin-token: ..." "https://api.maisprime.com.br/api/expo-updates/admin/releases?runtimeVersion=1.3.0"
curl -X POST -H "x-admin-token: ..." \
  https://api.maisprime.com.br/api/expo-updates/admin/releases/1.3.0/<nome-do-release-bom>/republicar
```

Só `desativar` não faz aparelhos voltarem (eles já têm o update em disco e o
expo-updates lança sempre o mais recente). Use `republicar`.

Limpeza: manter os últimos 3 a 5 releases por runtime; apagar o resto com
`DELETE /api/expo-updates/admin/releases/<runtime>/<nome>`.

---

## 7. Cuidados

### O que NUNCA pode ir por OTA

Exige build novo nas lojas e novo `runtimeVersion`:

- biblioteca com código nativo nova ou atualizada;
- upgrade do Expo SDK ou do React Native;
- `app.json` fora de JS: permissões, ícone, splash, `plugins`, `scheme`,
  `bundleIdentifier`/`package`, notificações;
- mudanças manuais em `android/` ou `ios/`;
- troca do certificado de code signing ou da URL de updates.

OTA com dependência nativa nova crasha o app na abertura para todos do
runtime. `republicar` do release anterior resolve, mas os usuários passam
pelo crash.

### `version` e `runtimeVersion` andam juntos

Subir os dois **somente** com build nativo. Se o `version` subir sem build, os
OTAs vão para um runtime que nenhum aparelho tem.

### Chave privada

Backup em dois lugares fora da máquina de desenvolvimento. Nunca no git, em
chat ou em log. Na VPS, só no `.env`.

### Deploy da API daqui em diante

A regra da arquitetura passa a valer para todo código novo (seção 4 de
`ARQUITETURA_ALVO_2026-09.md`). Para o deploy, o que muda na prática:

- `migrate status` **antes** e **depois** do `migrate deploy`, sempre.
- O smoke da seção 2.5 vira padrão de qualquer deploy, porque a ligação de
  módulos agora é explícita (`imports:`) e um esquecimento só aparece no boot.
- Os `*.contract.spec.ts` congelam o contrato do app; se um deles precisar de
  edição para passar, a mudança quebrou o app e não deve ser deployada.

### Apple

OTA de JS é permitido desde que não mude o propósito do app. Não usar OTA para
liberar o que a revisão rejeitaria.

### Usuários com app aberto

`ON_LOAD` aplica na próxima abertura fria. Para acelerar um fix crítico, use
push silenciosa (infra já existe) para o app chamar
`Updates.fetchUpdateAsync()` e avisar para reabrir. Evite
`Updates.reloadAsync()` automático no meio de um fluxo.

### Infra

- Banda: ~9 mil usuários × ~12 MB por publicação ≈ 110 GB por OTA, espalhados
  por dias. Com 16 TB/mês não há risco.
- Disco: 10 a 30 MB por release; com a limpeza da seção 6 fica abaixo de 500 MB.
- `updates-data` não precisa de backup (release é regenerável do commit). A
  chave privada precisa. O banco precisa (seção 2.1).

### Multi-tenant

MAIS_PRIME e MAIS_PRIME_RS recebem o mesmo bundle do mesmo servidor; nada por
base neste módulo. O clone Hertz tem URL de updates própria apontando para a
API dele, com par de chaves próprio.

---

## Checklist final

**Repositório**
- [ ] `npm run verify` verde na árvore completa
- [ ] Boot local a partir do `dist/` com `/health` ok e sem erro de DI
- [ ] Commits por bloco feitos; pasta `prisma/migrations/20260827142258_analytics_journey/` incluída
- [ ] `git push`; hash anotado

**VPS**
- [ ] Backup do MySQL
- [ ] `EXPO_UPDATES_PRIVATE_KEY_BASE64` no `.env`; `APP_URL` com `https://`
- [ ] Nginx com `client_max_body_size 200m`
- [ ] `migrate status` → `migrate deploy` → `migrate status` (up to date)
- [ ] `docker compose up -d --build api`; log sem `can't resolve` e sem `Code signing DESABILITADO`
- [ ] Smoke da seção 2.5 (health, login, boletos, rastreamento, admin status, analytics)

**App**
- [ ] Par de chaves de produção gerado, privada com backup em dois lugares
- [ ] `app.json`: URL de produção, certificado, `runtimeVersion` = `version`
- [ ] Plugin de cleartext removido; manifest sem `usesCleartextTraffic`
- [ ] `certs/certificate.pem` commitado; `keys/` ignorado
- [ ] Tag `build-<versão>` no commit do binário
- [ ] AAB e IPA aprovados nas lojas

**OTA**
- [ ] Primeiro OTA validado localmente antes de publicar
- [ ] Rollback testado uma vez em produção com um release inofensivo
