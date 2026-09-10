# Atualizações OTA self-hosted (expo-updates)

Servidor próprio de atualizações JS/assets para o app React Native (Expo), sem
EAS Update. Implementa o [Expo Updates Protocol](https://docs.expo.dev/technical-specs/expo-updates-1/)
dentro desta API, no módulo `src/expo-updates`.

Uma única instalação atende **MAIS_PRIME e MAIS_PRIME_RS**: os dois tenants
recebem o mesmo bundle, então não há nada por base neste módulo.

Plano de deploy em produção e cuidados: `docs/EXPO_UPDATES_DEPLOY_PRODUCAO.md`.

## 1. Como funciona

```
app abre ─► GET /api/expo-updates/manifest  (headers expo-runtime-version, expo-platform, expo-current-update-id)
                │
                ├─ 204                     → não existe release para esse runtime; app segue com o bundle embutido
                ├─ directive noUpdateAvailable → app já tem a versão mais recente
                └─ manifest (multipart)    → app baixa os assets que faltam em /api/expo-updates/assets?…
                                              valida hash SHA-256 e assinatura RSA, aplica na PRÓXIMA abertura
```

Layout em disco (volume `updates/`, montado pelo docker-compose):

```
updates/
└── 1.4.0/                         ← runtimeVersion (igual ao do binário nativo)
    ├── 20260904-140301-a1f2/      ← release (saída íntegra de `npx expo export`)
    │   ├── metadata.json
    │   ├── expoConfig.json
    │   ├── release.json           ← nossos metadados (criadoEm, descrição, origem)
    │   ├── _expo/static/js/{android,ios}/index-<hash>.hbc
    │   └── assets/<hash>
    └── 20260904-171522-9c0d/
        └── .desativada            ← marcador do kill-switch
```

Regras:

- O release ativo mais recente do `runtimeVersion` pedido é o que vale.
- Releases são **imutáveis**. Hashes são calculados uma vez e ficam em memória.
- Rollback = **republicar** um release antigo como um release novo (id e
  `createdAt` novos). Só desativar o release ruim não faz aparelhos que já
  baixaram voltarem, porque o expo-updates lança sempre o update de
  `commitTime` mais recente que tem em disco.

## 2. Endpoints

| Método | Rota | Auth | Uso |
|---|---|---|---|
| GET | `/api/expo-updates/manifest` | nenhuma | chamado pelo app |
| GET | `/api/expo-updates/assets?runtimeVersion&release&asset` | nenhuma | chamado pelo app; `Cache-Control: immutable` |
| GET | `/api/expo-updates/admin/status` | `x-admin-token` | pasta, assinatura, runtimes e release ativo de cada um |
| GET | `/api/expo-updates/admin/releases?runtimeVersion=` | `x-admin-token` | lista (mais recente primeiro) |
| POST | `/api/expo-updates/admin/publicar` | `x-admin-token` | multipart: `arquivo` (zip), `runtimeVersion`, `descricao?` |
| POST | `/api/expo-updates/admin/releases/:rv/:nome/republicar` | `x-admin-token` | **rollback** |
| POST | `/api/expo-updates/admin/releases/:rv/:nome/desativar` | `x-admin-token` | kill-switch |
| POST | `/api/expo-updates/admin/releases/:rv/:nome/reativar` | `x-admin-token` | desfaz o kill-switch |
| DELETE | `/api/expo-updates/admin/releases/:rv/:nome` | `x-admin-token` | apaga do disco |

`x-admin-token` = `ADMIN_PANEL_TOKEN` (mesmo guard das integrações sem JWT).

## 3. Configuração na VPS (uma vez)

Tudo é opcional, mas a chave de assinatura é fortemente recomendada.

1. Gerar as chaves **no projeto do app** (funciona no Windows):

   ```bash
   npx expo-updates codesigning:generate \
     --key-output-directory keys \
     --certificate-output-directory certs \
     --certificate-validity-duration-years 10 \
     --certificate-common-name "Mais Prime"
   ```

   - `certs/certificate.pem` → vai para o app (commitado no repo do app).
   - `keys/private-key.pem` → vai para a VPS. **Nunca** commitar. Se vazar,
     qualquer pessoa consegue empurrar código para todos os aparelhos.

2. No `.env` da API, uma linha (escolha uma forma):

   ```bash
   # conteúdo do .pem em base64 numa linha só — funciona com env_file do docker
   EXPO_UPDATES_PRIVATE_KEY_BASE64=$(base64 -w0 keys/private-key.pem)
   # ou caminho de um arquivo montado no container
   EXPO_UPDATES_PRIVATE_KEY_PATH=keys/private-key.pem
   ```

   `APP_URL` já existe e é usada como base das URLs dos assets. Se a API for
   servida em outro host para o app, defina `EXPO_UPDATES_PUBLIC_URL`.

3. `docker compose up --build`. O volume `updates-data` já está no compose.

4. Nginx/Traefik na frente: `client_max_body_size 200m` na rota
   `/api/expo-updates/admin/publicar` (o zip do export tem 5 a 30 MB).

5. Conferir: `curl -H "x-admin-token: $TOKEN" https://api.../api/expo-updates/admin/status`
   deve mostrar `assinaturaHabilitada: true`.

## 4. Configuração no app (um build nativo, uma vez)

`app.json`:

```jsonc
{
  "expo": {
    "version": "1.4.0",
    "runtimeVersion": { "policy": "appVersion" },   // ou uma string fixa
    "updates": {
      "enabled": true,
      "url": "https://api.suaempresa.com.br/api/expo-updates/manifest",
      "checkAutomatically": "ON_LOAD",
      "fallbackToCacheTimeout": 0,
      "codeSigningCertificate": "./certs/certificate.pem",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
    }
  }
}
```

- `runtimeVersion` é o contrato entre binário e update. Com a policy
  `appVersion` ele é igual ao `version`, que você já incrementa a cada build.
  **Toda mudança nativa** (lib com código nativo, permissão, SDK do Expo) exige
  novo build e, portanto, novo `runtimeVersion`. Updates de um runtime nunca
  chegam a binários de outro.
- Depois de alterar `app.json`, rodar `npx expo prebuild` (ou aplicar as
  mudanças em `android/` e `ios/` manualmente se o projeto for bare) e gerar o
  binário como sempre (`./gradlew bundleRelease` / `eas build`). A URL e o
  certificado ficam compilados no app.

### Estratégia de aplicação recomendada

`ON_LOAD` + `fallbackToCacheTimeout: 0`: o app abre na hora com o bundle
atual, baixa o novo em segundo plano e aplica na próxima abertura fria.
Complemento opcional, sem reload forçado:

```ts
import * as Updates from 'expo-updates';

// ao voltar para o foreground, no máximo a cada 30 min
const { isAvailable } = await Updates.checkForUpdateAsync();
if (isAvailable) await Updates.fetchUpdateAsync(); // só baixa; aplica na próxima abertura
```

Só chame `Updates.reloadAsync()` em tela neutra (home) ou atrás de um banner
"Nova versão disponível". Reload no meio de revistoria/pagamento vira bug.

## 5. Publicar uma atualização (rotina)

Na raiz do projeto do app, com o script copiado de `scripts/publicar-update.mjs`
desta API (ou apontando para ele):

```bash
node scripts/publicar-update.mjs \
  --api https://api.suaempresa.com.br \
  --token "$ADMIN_PANEL_TOKEN" \
  --descricao "corrige tela de boletos"
```

O script:

1. roda `npx expo export --platform all --output-dir dist` (gera Android **e iOS**;
   não precisa de Mac — o `hermesc` roda no Windows/Linux);
2. lê `runtimeVersion` de `dist/expoConfig.json` (string, ou `version` se a
   policy for `appVersion`; senão passe `--runtime-version`);
3. zipa `dist/` e faz o upload para `/api/expo-updates/admin/publicar`.

Leva menos de dois minutos. Opções: `--platform android|ios`, `--skip-export`,
`--dist <pasta>`, `--dry-run`, `--runtime-version`. Envs alternativas:
`OTA_API_URL`, `OTA_ADMIN_TOKEN`.

Rollback:

```bash
curl -H "x-admin-token: $TOKEN" https://api.../api/expo-updates/admin/releases?runtimeVersion=1.4.0
curl -X POST -H "x-admin-token: $TOKEN" \
  https://api.../api/expo-updates/admin/releases/1.4.0/20260904-140301-a1f2/republicar
```

## 6. Teste local com APK de release (sem VPS)

Objetivo: instalar um `assembleRelease`, mudar JS, publicar no servidor local e
ver o app trocar de bundle.

1. **API local** (`.env`):

   ```bash
   EXPO_UPDATES_PRIVATE_KEY_PATH=../app/keys/private-key.pem
   EXPO_UPDATES_PUBLIC_URL=auto     # URLs dos assets seguem o host da requisição
   ADMIN_PANEL_TOKEN=teste
   ```

   `auto` existe para o cenário de túnel (Cloudflare/ngrok), cuja URL muda a
   cada reinício: sem ele, o manifest sairia com URLs de assets de um túnel
   morto e o app baixaria o manifest mas nunca os assets (sintoma: log com
   `manifest 200` e nenhum `GET /assets`). Em produção use URL fixa.

   `npm run start:dev`. O log de boot mostra se a assinatura está habilitada.
   O `.env` é lido só no boot: mudou o `.env`, reinicie a API.

2. **App** (`app.json`): `updates.url = "http://192.168.0.10:3001/api/expo-updates/manifest"`.
   Android bloqueia HTTP sem TLS em builds de release. Para o teste, libere
   com o plugin `expo-build-properties`:

   ```jsonc
   "plugins": [["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]]
   ```

   Remova antes do build de produção (ou use um túnel HTTPS como ngrok, que
   também serve para testar iOS).

3. Gerar e instalar: `cd android && ./gradlew assembleRelease` →
   `adb install app/build/outputs/apk/release/app-release.apk`. Abrir o app
   uma vez (roda o bundle embutido).

4. Mudar algo visível no JS e publicar:

   ```bash
   node scripts/publicar-update.mjs --api http://192.168.0.10:3001 --token teste --descricao "teste OTA"
   ```

5. Fechar o app por completo e abrir: o log da API mostra `GET /api/expo-updates/manifest 200`
   e os downloads de assets. Fechar e abrir de novo: o app já está com o JS novo.

   Depuração no app: `Updates.updateId`, `Updates.isEmbeddedLaunch`,
   `Updates.createdAt`. Se o manifest voltar 400, o servidor está sem chave e o
   app pede assinatura; se voltar 204, o `runtimeVersion` do binário não bate
   com a pasta publicada.

## 7. Limites e cuidados

- OTA não altera código nativo, `app.json` nativo, ícones, splash ou permissões.
- Apple aceita OTA de JS desde que não mude a finalidade do app. Mesma regra do EAS Update.
- Capacidade: ~9 mil usuários × ~5 MB por publicação ≈ 45 GB espalhados por
  horas/dias. Com 16 TB/mês de banda não há gargalo; CPU/RAM são irrelevantes.
- O manifest é `private, max-age=0`; os assets são `immutable` por um ano
  (nomes já carregam hash). Um CDN na frente é opcional.
- Limpeza: guarde os últimos 3–5 releases por runtime e apague o resto com
  `DELETE …/releases/:rv/:nome`. Runtimes sem usuários ativos podem ser removidos.
- Envs: todas em `expo-updates.config.ts` e documentadas em `.env.example`.
