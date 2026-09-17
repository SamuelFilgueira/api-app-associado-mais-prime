# Guia rápido — Release de loja e atualização OTA pela VPS

Guia operacional, direto ao ponto. Detalhes e teoria: `EXPO_UPDATES_OTA.md`
(técnico) e `EXPO_UPDATES_DEPLOY_PRODUCAO.md` (deploy do servidor).

**Variáveis usadas nos comandos** — o fluxo é idêntico para todas as marcas;
só mudam os valores. Cada marca tem VPS, token, par de chaves e pasta de app
próprios:

| Variável | Mais Prime | Hertz |
|---|---|---|
| `<API>` | `https://app-dev.texvngroup.com.br` | `https://apphertz.texvngroup.com.br` |
| `<TOKEN>` | `ADMIN_PANEL_TOKEN` do `.env` da VPS Mais Prime | `ADMIN_PANEL_TOKEN` do `.env` da VPS Hertz |
| Raiz do app | `C:/AppAssociadoNewDesign/AppAssociado` | `C:/AppAssociadoHertz/AppAssociadoHertz/AppAssociado` |
| Chave privada (VPS) | `keys/private-key.pem` do app Mais Prime | `keys/private-key.pem` do app Hertz |

Script de publicação (único para todas): `beneficios-api/scripts/publicar-update.mjs`.

> **Nunca cruze os valores**: publicar o export da Hertz na VPS da Mais Prime
> (ou vice-versa) entregaria o app de uma marca aos usuários da outra. O
> code signing protege contra isso (o certificado embutido em cada binário só
> aceita manifests assinados pela chave da própria VPS), mas confira o `--api`
> antes de publicar.

---

## 0. Qual fluxo usar?

| Mudança | Fluxo |
|---|---|
| Só JS/TS, telas, textos, imagens do bundle, lógica | **OTA** (seção 2) — minutos |
| Lib nativa nova/atualizada, upgrade Expo SDK/RN, permissões, ícone, splash, plugins, notificações, certificado, URL de updates | **Release de loja** (seção 1) — dias |

Na dúvida se uma lib é nativa: se precisou de `expo install`/`npm install` e o
pacote tem pasta `android/` ou `ios/`, é nativa → loja.

---

## 1. Release de loja (build nativo)

### 1.1 Subir versão (raiz do app)

Editar `app.json` — **três** campos:

```jsonc
"version": "1.3.0",          // nova versão
"runtimeVersion": "1.3.0",   // SEMPRE igual ao version
"android": { "versionCode": 50 }   // +1 sobre o anterior
```

iOS: subir também `ios.buildNumber` (+1).

> `runtimeVersion` é o contrato entre binário e OTA. Nunca subir `version`
> sem build de loja — os OTAs iriam para um runtime que ninguém tem.

Aplicar no nativo e conferir:

```bash
npx expo prebuild --platform android
grep expo_runtime_version android/app/src/main/res/values/strings.xml   # nova versão
grep -E "versionCode|versionName" android/app/build.gradle | head -2    # 50 / 1.3.0
```

### 1.2 Android — AAB local

```bash
cd android && rm -rf app/.cxx && ./gradlew bundleRelease --no-daemon
```

Artefato: `android/app/build/outputs/bundle/release/app-release.aab` →
subir manualmente no Play Console e aguardar revisão.

### 1.3 iOS — build e submit pelo EAS

```bash
eas build --platform ios --profile production
eas submit --platform ios
```

Depois criar a release no App Store Connect e aguardar a revisão.

### 1.4 Commit e tag

```bash
git add app.json android/
git commit -m "build: 1.3.0"
git tag build-1.3.0 && git push --tags
```

Todo OTA futuro do runtime `1.3.0` deve sair de um commit descendente dessa
tag, sem mudanças nativas.

### 1.5 Regra de ouro

**Não publicar OTA para o runtime novo enquanto as lojas revisam.** O binário
em revisão baixaria o OTA e o que a Apple revisou deixaria de ser o que roda.
Publicar só com o app disponível para download.

---

## 2. Atualização OTA (JS only) pela VPS

Pré-condição: mudança 100% JS/assets, no branch da tag `build-<runtime>`.

### 2.1 Publicar (raiz do app, Git Bash)

```bash
cd /c/AppAssociadoNewDesign/AppAssociado
node /c/Users/leuma/Desktop/Projetos/App-associado/beneficios-api/scripts/publicar-update.mjs \
  --api <API> --token "<TOKEN>" --descricao "1.3.0 - corrige tela de boletos (commit abc123)"
```

O script faz tudo: `expo export` (android + ios), resolve o `runtimeVersion`
do `app.json`, zipa e envia. Leva ~2 min. A `--descricao` é como você
identifica o release depois — sempre cite o que mudou e o commit.

Parâmetros opcionais do script:

| Flag | Uso |
|---|---|
| `--platform android\|ios` | publicar só uma plataforma (default: as duas) |
| `--runtime-version X` | forçar runtime (default: lido do app.json) |
| `--skip-export` | reaproveitar a pasta `dist/` já exportada |
| `--dry-run` | gerar o zip sem enviar |

### 2.2 Conferir

```bash
curl -H "x-admin-token: <TOKEN>" "<API>/api/expo-updates/admin/releases?runtimeVersion=1.3.0"
```

O primeiro item da lista (mais novo) deve ser o que você acabou de publicar.
No log da API, aparelhos baixando aparecem como `GET /api/expo-updates/manifest 200`
seguido de `GET /api/expo-updates/assets 200`.

### 2.3 Como chega no usuário

O update baixa em segundo plano na abertura do app e **aplica na abertura
seguinte**. A distribuição se espalha ao longo de horas/dias conforme os
usuários abrem o app. Não há como forçar aparelho fechado.

---

## 3. Rollback (reverter um OTA ruim)

1. Listar e identificar o release bom pela `descricao`:

```bash
curl -H "x-admin-token: <TOKEN>" "<API>/api/expo-updates/admin/releases?runtimeVersion=1.3.0"
```

Lista vem do mais novo para o mais antigo; o atual é o primeiro, o candidato
a rollback normalmente é o segundo. Copiar o campo `nome` (ex.:
`20260914-170233-878`).

2. Republicar o release bom (vira um release novo com o conteúdo antigo):

```bash
curl -X POST -H "x-admin-token: <TOKEN>" \
  <API>/api/expo-updates/admin/releases/1.3.0/<NOME_DO_RELEASE_BOM>/republicar
```

Resposta esperada: `"origem": "rollback:<nome>"`. Aparelhos voltam na próxima
abertura, igual a um update normal.

> `desativar` sozinho NÃO reverte quem já baixou — use sempre `republicar`.

---

## 4. Endpoints de administração (referência)

Todos exigem o header `x-admin-token: <TOKEN>`. Base: `<API>/api/expo-updates/admin`.

| Ação | Comando |
|---|---|
| Status geral (assinatura, URL, release ativo por runtime) | `curl -H "x-admin-token: <TOKEN>" <API>/api/expo-updates/admin/status` |
| Listar releases de um runtime | `curl -H "x-admin-token: <TOKEN>" "<API>/api/expo-updates/admin/releases?runtimeVersion=1.3.0"` |
| Rollback | `curl -X POST -H "x-admin-token: <TOKEN>" <API>/api/expo-updates/admin/releases/<runtime>/<nome>/republicar` |
| Kill-switch (parar de servir; quem baixou mantém) | `curl -X POST -H "x-admin-token: <TOKEN>" <API>/api/expo-updates/admin/releases/<runtime>/<nome>/desativar` |
| Reativar | `curl -X POST -H "x-admin-token: <TOKEN>" <API>/api/expo-updates/admin/releases/<runtime>/<nome>/reativar` |
| Apagar do disco (irreversível; limpeza) | `curl -X DELETE -H "x-admin-token: <TOKEN>" <API>/api/expo-updates/admin/releases/<runtime>/<nome>` |

Limpeza recomendada: manter os últimos 3–5 releases por runtime; runtimes sem
usuários podem ser apagados inteiros.

---

## 5. Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Script falha com 413 | `client_max_body_size` do Nginx abaixo de 200m no bloco 443 do domínio |
| Script falha com 401 | `--token` diferente do `ADMIN_PANEL_TOKEN` do `.env` da VPS |
| Publicou e app responde `manifest 204` | runtime publicado ≠ runtime do binário (conferir `expo_runtime_version` do APK vs. pasta em `updates/`) |
| App baixa manifest mas nenhum `GET /assets` no log | `EXPO_UPDATES_PUBLIC_URL` da VPS errada — manifest aponta assets para host inválido |
| `manifest 400` no log | VPS sem chave (`EXPO_UPDATES_PRIVATE_KEY_BASE64`) e app exigindo assinatura |
| Publicou e nada muda no aparelho | update aplica na **segunda** abertura fria; conferir também se abriu o app de fato |
| App crasha ao abrir após OTA | foi publicado código com dependência nativa nova → rollback (seção 3) e refazer como release de loja |

## 6. Checklist-relâmpago antes de cada OTA

- [ ] Mudança é só JS/assets?
- [ ] Estou no branch/commit certo do runtime em produção?
- [ ] Testei local (APK de release do mesmo runtime)?
- [ ] `--descricao` identifica mudança e commit?
- [ ] Depois de publicar: listagem confere e um aparelho da equipe recebeu?
