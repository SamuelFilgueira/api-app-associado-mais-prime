# Analytics — Jornada do Usuário (aparelhos, modelo, telas com horário)

> Extensão **aditiva** do módulo de analytics (`src/analytics`) que responde, por
> conta de usuário: *em quantos celulares está logada*, *qual o modelo/SO de cada
> um*, *que telas/ações/formulários percorreu e em que horário* — o caminho
> completo dentro do app.
>
> Ligada por `ANALYTICS_JOURNEY_ENABLED=true`. Desligada, o comportamento do
> módulo é **idêntico** ao anterior (`docs/ANALYTICS_IMPLEMENTATION.md`).
>
> Uso previsto: ambiente de dev e VPS de teste com usuários que **autorizaram**
> a coleta. Ver seção 9 (LGPD) antes de ligar em qualquer outro lugar.

Data: 2026-08-27 · Migration: `20260827142258_analytics_journey`

---

## Sumário

1. [Motivação](#1-motivação)
2. [Decisões de arquitetura](#2-decisões-de-arquitetura)
3. [Contrato do endpoint de ingestão (aditivo)](#3-contrato-do-endpoint-de-ingestão-aditivo)
4. [Roteiro para o frontend (Expo)](#4-roteiro-para-o-frontend-expo)
5. [Modelo de dados](#5-modelo-de-dados)
6. [Endpoints de consulta (admin)](#6-endpoints-de-consulta-admin)
7. [Variáveis de ambiente e deploy](#7-variáveis-de-ambiente-e-deploy)
8. [Performance e escalabilidade](#8-performance-e-escalabilidade)
9. [Privacidade / LGPD](#9-privacidade--lgpd)
10. [Limitações conhecidas](#10-limitações-conhecidas)
11. [Playbook: investigação de acesso](#11-playbook-investigação-de-acesso)
12. [Arquivos alterados/criados](#12-arquivos-alteradoscriados)

---

## 1. Motivação

Na investigação do acesso à tela de rastreamento da placa TUJ7J72 (25/08/2026)
o backend conseguia provar apenas, cruzando `AnalyticsSummaryReceipt` com os
logs do nginx, que **duas instalações Android** usavam a conta do `userId 266`.
Não havia:

- modelo/SO do aparelho (nada no schema, nem no `LoggingInterceptor`);
- horário em que uma tela foi aberta — `AnalyticsScreenDaily` é agregada por
  dia e **sem vínculo com usuário** (por design de privacidade);
- noção de "logado em quantos aparelhos" — o JWT é stateless (300 dias) e o
  `expoPushToken` do `user` guarda um único aparelho.

Este documento descreve o que foi adicionado para cobrir esses pontos sem
alterar a cadência de rede do app.

## 2. Decisões de arquitetura

| # | Decisão | Por quê |
|---|---|---|
| D1 | **Zero requests novas.** Os dados viajam dentro do mesmo `POST /api/analytics/summaries` que o app já envia (background / fechar / timer de 30 min). | Requisito de fluidez. O tracker apenas acumula mais dois blocos em memória e envia junto no flush. |
| D2 | **Contrato 100% aditivo.** `device` e `journey` são campos **opcionais** do payload existente; nenhum campo antigo mudou, nenhuma validação ficou mais restritiva. | Apps já publicados continuam funcionando; o rollout do frontend pode ser gradual. |
| D3 | **Feature flag por ambiente** (`ANALYTICS_JOURNEY_ENABLED`). Com a flag off, `device`/`journey` são ignorados por completo (não persistidos, não contam como descarte). | Produção atual não muda nada. Só a VPS de teste liga. |
| D4 | **Mesmo job BullMQ, mesma transação.** Aparelho, vínculo conta↔aparelho e eventos são gravados dentro da transação que já grava recibo + agregados. | Atomicidade: retry do job não gera evento órfão nem vínculo sem recibo. Nenhum worker novo. |
| D5 | **Eventos com horário do aparelho** (`t`), validados contra a janela do summary (±5 min). Fora disso, descartados. | Horário "saudável" como o analytics atual, sem confiar cegamente no relógio do celular. |
| D6 | **Allowlists reaproveitadas.** Um evento só é aceito se o nome estiver em `ALLOWED_SCREENS` / `ALLOWED_ACTIONS` / `ALLOWED_FORMS` conforme o `type`. Scanner de chaves proibidas continua rodando no body inteiro. | Não abre porta para o app mandar texto livre, CPF, placa etc. |
| D7 | **Identidade do aparelho = `installHash`** (o mesmo HMAC das tabelas agregadas). Nenhum ID bruto (UUID, android_id, IDFA) é aceito — continuam proibidos. | Tudo cruza com o que já existe (`AnalyticsSummaryReceipt`, `AnalyticsInstallFirstSeen`) sem novo identificador. |
| D8 | **"Logado" é inferido, não declarado**: um summary com `Authorization` válido vindo do `installHash` X cria/atualiza o vínculo `(userId, X)`. `auth_login_success` / `auth_logout` na jornada preenchem `lastLoginAt` / `lastLogoutAt`. | Não exige endpoint de "registrar dispositivo" nem mudança no login. Flush pós-logout (sem token) ainda registra o logout no último vínculo do aparelho. |
| D9 | **Modelo/SO só do `expo-device`** (brand, model, modelId, osName, osVersion, deviceType) + timezone. **Não** aceitar `deviceName` (nome dado pelo usuário). | Identifica o aparelho sem dado pessoal. |
| D10 | **Retenção com TTL** (`ANALYTICS_JOURNEY_TTL_DAYS`, padrão 90) via job repetível na fila de analytics (03:30 BRT), apagando em lotes de 5 000 com `LIMIT`. Aparelhos e vínculos não expiram. | Tabela de eventos é a única que cresce linearmente; limpeza sem lock longo. |
| D11 | Limite do payload subiu de 32 KB para **64 KB**; `journey` aceita até **400 eventos** por summary. | Cabe um período inteiro de 30 min de uso intenso sem forçar flush extra. Payload antigo (~2 KB) permanece válido. |
| D12 | Consultas **somente por endpoints admin** (`JwtAuthGuard` + `AdminRoleGuard`), paginadas por cursor, sempre sobre índices. | Nunca varrem a tabela; os dados não são expostos ao app. |

## 3. Contrato do endpoint de ingestão (aditivo)

`POST /api/analytics/summaries` — tudo que existia continua igual. Campos novos
(**opcionais**):

```jsonc
{
  "period_start": "2026-08-27T18:00:00.000Z",
  "period_end":   "2026-08-27T18:30:00.000Z",
  "app":     { "platform": "android", "version": "1.4.0", "runtime_version": "1.0.0" },
  "session": { "session_id": "<uuid v4>", "anonymous_install_id": "<uuid v4>" },
  "screens": [ ... ],   // inalterado
  "actions": [ ... ],   // inalterado
  "forms":   [ ... ],   // inalterado

  // ── NOVO (opcional) ──
  "device": {
    "brand":       "samsung",          // ≤40
    "model":       "SM-A155M",         // ≤80
    "model_id":    "a15",              // ≤40  (Device.modelId / codename)
    "os_name":     "Android",          // ≤20
    "os_version":  "14",               // ≤20
    "device_type": "phone",            // phone|tablet|desktop|tv|unknown
    "timezone":    "America/Sao_Paulo" // ≤60
  },

  // ── NOVO (opcional) — lista ORDENADA de eventos do período ──
  "journey": [
    { "t": "2026-08-27T18:00:03.120Z", "type": "screen", "event": "screen_login" },
    { "t": "2026-08-27T18:00:09.400Z", "type": "form",   "event": "form_login", "screen": "screen_login", "outcome": "submitted" },
    { "t": "2026-08-27T18:00:10.010Z", "type": "action", "event": "auth_login_success" },
    { "t": "2026-08-27T18:00:10.300Z", "type": "screen", "event": "screen_home", "duration_ms": 12400 },
    { "t": "2026-08-27T18:00:22.700Z", "type": "screen", "event": "screen_rastreamento", "duration_ms": 61000 }
  ]
}
```

| Campo | Regra |
|---|---|
| `journey[].t` | ISO 8601. Aceito se estiver em `[period_start − 5 min, period_end + 5 min]`. |
| `journey[].type` | `screen` \| `action` \| `form`. |
| `journey[].event` | Nome da allowlist do tipo. **Não usar a chave `name`** — é proibida pelo scanner (D6). |
| `journey[].duration_ms` | Só `screen`; clamp 0–3 600 000. |
| `journey[].screen` / `outcome` | Só `form`; `outcome` ∈ `started|submitted|success|error`. |
| Tamanho | ≤ 400 eventos; payload total ≤ 64 KB. Excedentes são descartados e contados em `discardedItemsCount` do recibo (payload **não** é rejeitado). |
| Flag off | `device`/`journey` são ignorados silenciosamente; resposta continua `202 { message: "accepted" }`. |

Validação de schema continua devolvendo **422**; rate limits (10/min por IP,
20/h por install) **não mudaram** — o volume de requests é o mesmo.

## 4. Roteiro para o frontend (Expo)

### 4.1 Bloco `device` (uma vez por flush, custo zero)

```ts
import * as Device from 'expo-device';
import { Platform } from 'react-native';

export function getDeviceInfo() {
  return {
    brand: Device.brand ?? undefined,
    model: Device.modelName ?? undefined,
    model_id: Device.modelId ?? undefined,
    os_name: Device.osName ?? Platform.OS,
    os_version: Device.osVersion ?? undefined,
    device_type: mapDeviceType(Device.deviceType), // DeviceType.PHONE -> 'phone' ...
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
```

Não enviar `Device.deviceName`.

### 4.2 Buffer da jornada (memória, sem I/O)

O tracker já mantém `screenCounts`/`actionCounts` por período. Adicione um
array `journey` alimentado nos **mesmos pontos** onde hoje se incrementa o
agregado:

```ts
class AnalyticsTracker {
  private journey: JourneyEvent[] = [];
  private static MAX_JOURNEY = 400;

  private pushJourney(e: JourneyEvent) {
    if (this.journey.length >= AnalyticsTracker.MAX_JOURNEY) return; // servidor também corta em 400
    this.journey.push(e);
  }

  trackScreenExit(screen: string, durationMs: number) {
    // agregados (já existia)
    this.screenCounts.set(screen, (this.screenCounts.get(screen) ?? 0) + 1);
    this.screenTimeMs.set(screen, (this.screenTimeMs.get(screen) ?? 0) + durationMs);
    // jornada (novo) — t = momento da ENTRADA na tela
    this.pushJourney({ t: this.screenEnteredAt.toISOString(), type: 'screen', event: screen, duration_ms: durationMs });
  }

  trackAction(action: string) {
    this.actionCounts.set(action, (this.actionCounts.get(action) ?? 0) + 1);
    this.pushJourney({ t: new Date().toISOString(), type: 'action', event: action });
  }

  trackForm(screen: string, form: string, outcome: FormOutcome) {
    /* agregados... */
    this.pushJourney({ t: new Date().toISOString(), type: 'form', event: form, screen, outcome });
  }

  async flush() {
    const payload = {
      ...payloadAtual,               // period_*, app, session, screens, actions, forms
      device: getDeviceInfo(),       // novo
      journey: this.journey,         // novo
    };
    try { await api.post('/analytics/summaries', payload); }
    catch { /* silencioso, como hoje */ }
    finally { this.reset(); /* zera journey junto */ }
  }
}
```

Regras que mantêm a fluidez:

- **Nada de flush por evento.** Gatilhos permanecem os de hoje (background,
  fechamento, timer de 30 min).
- A tela em que o usuário está no momento do flush é registrada com o
  `duration_ms` parcial e reaberta no próximo período (mesmo comportamento
  dos agregados).
- Se o buffer chegar a 400 eventos antes do flush (uso muito intenso), pare
  de anexar — o servidor descartaria de qualquer forma. Não force um flush
  extra.
- Sempre enviar `Authorization: Bearer <jwt>` quando o usuário estiver logado
  (já é o comportamento do interceptor). Sem ele, o evento é gravado só por
  aparelho e não entra na lista de "aparelhos logados" da conta.

## 5. Modelo de dados

### 5.1 `AnalyticsDevice` — um por instalação

| Campo | Tipo | Descrição |
|---|---|---|
| `installHash` | `VARCHAR(64)` único | HMAC do `anonymous_install_id` (mesmo das outras tabelas). |
| `platform`, `appVersion`, `runtimeVersion` | | Última versão vista. |
| `brand`, `model`, `modelId`, `osName`, `osVersion`, `deviceType`, `timezone` | `?` | Do bloco `device`; só sobrescritos quando vêm no payload. |
| `lastSessionHash`, `lastUserId`, `lastIp` | `?` | Última sessão / última conta autenticada / IP do último summary. |
| `summariesCount` | | Quantos summaries este aparelho enviou. |
| `firstSeenAt`, `lastSeenAt` | | Primeiro/último summary (horário do servidor). |

### 5.2 `AnalyticsUserDevice` — vínculo conta ↔ aparelho

Uma linha por `(userId, installHash)`. É a resposta a "em quantos celulares a
conta está logada".

| Campo | Descrição |
|---|---|
| `firstSeenAt` / `lastSeenAt` | Primeiro/último summary **autenticado** desta conta neste aparelho. |
| `lastLoginAt` / `lastLogoutAt` | Horário (do aparelho) da última ação `auth_login_success` / `auth_logout`. |
| `summariesCount`, `lastAppVersion`, `lastSessionHash`, `platform` | Contexto do último uso. |

Status calculado na consulta (`active_days`, padrão 30):

- **ATIVO** — `lastSeenAt` dentro da janela e sem logout posterior;
- **DESLOGADO** — `lastLogoutAt ≥ lastSeenAt`;
- **INATIVO** — sem summary autenticado dentro da janela.

### 5.3 `AnalyticsJourneyEvent` — linha do tempo

| Campo | Descrição |
|---|---|
| `occurredAt` | Horário do aparelho (`t`), UTC. |
| `receivedAt`, `receiptId` | Horário do servidor e recibo (`AnalyticsSummaryReceipt.id`) que trouxe o evento. |
| `userId` `?` | Conta autenticada no summary (null antes do login). |
| `installHash`, `sessionHash`, `platform`, `appVersion` | Contexto. |
| `seq` | Posição dentro do summary (eventos já ordenados por `t`). |
| `eventType` | `SCREEN` \| `ACTION` \| `FORM`. |
| `name` | Nome da tela/ação/formulário. |
| `screen`, `outcome`, `durationMs` | Detalhes por tipo. |

Índices: `(userId, occurredAt)`, `(installHash, occurredAt)`, `(sessionHash)`,
`(occurredAt)` (limpeza), `(name, occurredAt)` (quem viu a tela X).

### 5.4 Alterações em tabelas existentes

- `AnalyticsSummaryReceipt.journeyEventsCount` (default 0) + índices
  `(analyticsUserId, receivedAt)` e `(installHash, receivedAt)` — as consultas
  feitas à mão na investigação de 25/08 agora usam índice.

## 6. Endpoints de consulta (admin)

Prefixo `/api/analytics/journey`, guardas `JwtAuthGuard` + `AdminRoleGuard`
(`role === ADMIN` no JWT). Todos os horários voltam em UTC (`*At`) **e** em
Brasília (`*AtBrt`, `dd/mm/aaaa hh:mm:ss`).

Filtros comuns (`AnalyticsJourneyQueryDto`): `from`, `to` (ISO; default
últimos 7 dias; máximo 92 dias), `install` (installHash completo ou prefixo ≥ 8),
`event` (nome), `limit` (1–1000, default 200), `cursor` (id do último item da
página anterior → `nextCursor` da resposta).

| Endpoint | Responde |
|---|---|
| `GET /users/:userId/devices?active_days=30` | Aparelhos que já usaram a conta, modelo/SO, status e `activeDevicesCount`. `otherAccountsOnDevice` indica celular compartilhado. |
| `GET /users/:userId/events?...` | Linha do tempo da conta (tela/ação/form com horário e aparelho). |
| `GET /users/:userId/sessions?...` | Sessões da conta com o `path` completo (até 5 000 eventos lidos / 100 sessões; `truncated=true` avisa). |
| `GET /devices/:installHash` | Ficha do aparelho + todas as contas que já o usaram. |
| `GET /devices/:installHash/events?...` | Linha do tempo do aparelho, inclusive antes do login. |
| `GET /vehicles/:chassiOuPlaca/events?...` | Eventos das contas donas do veículo (`UserVehicle`). |
| `GET /events/:name/viewers?from&to` | Quem viu a tela / executou a ação no intervalo, por conta+aparelho, com primeiro/último horário. |

Exemplo — `GET /api/analytics/journey/users/266/devices`:

```jsonc
{
  "user": { "id": 266, "name": "ARISTIDES ...", "baseOrigin": "MAIS_PRIME" },
  "activeWindowDays": 30,
  "activeDevicesCount": 2,
  "devices": [
    {
      "installHash": "b1e0becc…", "installHashShort": "b1e0becc",
      "platform": "android", "brand": "samsung", "model": "SM-A155M",
      "osName": "Android", "osVersion": "14", "deviceType": "phone",
      "label": "samsung SM-A155M · Android 14",
      "status": "ATIVO",
      "firstSeenAtBrt": "03/08/2026 09:12:40", "lastSeenAtBrt": "27/08/2026 14:03:11",
      "lastLoginAtBrt": "03/08/2026 09:10:02", "lastLogoutAt": null,
      "lastAppVersion": "1.4.0", "summariesCount": 45, "otherAccountsOnDevice": 0
    }
  ]
}
```

Exemplo — `GET /api/analytics/journey/events/screen_rastreamento/viewers?from=2026-08-25T22:40:00Z&to=2026-08-25T22:50:00Z`
devolve, por conta e aparelho, quem abriu a tela naquela janela.

## 7. Variáveis de ambiente e deploy

```env
ANALYTICS_JOURNEY_ENABLED=false   # true SÓ em dev / VPS de teste com consentimento
ANALYTICS_JOURNEY_TTL_DAYS=90     # retenção dos eventos (aparelhos/vínculos não expiram)
```

Dependências já existentes: `ANALYTICS_SECRET` (hash do install) e
`ANALYTICS_LINK_USER_ENABLED=true` (sem ela o `userId` não é extraído do JWT
e a jornada fica só por aparelho).

Passos:

1. `npx prisma migrate deploy` (produção) — ou, no banco local com drift,
   `npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20260827142258_analytics_journey/migration.sql`
   seguido de `npx prisma migrate resolve --applied 20260827142258_analytics_journey`.
2. `npx prisma generate` + build.
3. Ligar a flag no `.env` da VPS de teste e recriar o container
   (`docker compose up -d api`).
4. No nginx, garantir `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
   — sem isso `AnalyticsDevice.lastIp` grava o gateway do Docker (`172.18.0.1`),
   como acontece hoje no `LoggingInterceptor`.
5. Publicar o app com os blocos `device`/`journey` (seção 4). Até lá, a API já
   aceita os dois formatos.

Ao subir, o log mostra
`Jornada do usuário ATIVA (ANALYTICS_JOURNEY_ENABLED=true) — limpeza diária agendada às 03:30`.

## 8. Performance e escalabilidade

- **Rede:** 0 requests adicionais. O summary cresce de ~2 KB para, no pior
  caso, ~25 KB (400 eventos) a cada 30 min.
- **Ingestão (request):** validação + sanitização em memória (O(n) sobre os
  eventos, n ≤ 400) e um `queue.add` — mesmo caminho de antes; a resposta
  continua `202` imediata.
- **Persistência (worker):** +1 upsert (`AnalyticsDevice`), +1 upsert
  (`AnalyticsUserDevice`) e **um único** `createMany` para todos os eventos,
  dentro da transação existente. Sem N+1.
- **Leitura:** todas as consultas usam índice composto + `take`/cursor;
  `sessions` é a única que agrupa em memória e tem teto explícito (5 000).
- **Crescimento:** ~100–300 eventos por usuário ativo/dia. Para 5 000 usuários
  ativos ≈ 1 M linhas/dia → ~90 M em 90 dias (~10 GB com índices). Para a VPS
  de teste é irrelevante; para uma base grande, reduzir `ANALYTICS_JOURNEY_TTL_DAYS`
  ou ligar a flag por período de investigação.
- **Limpeza:** `DELETE … LIMIT 5000` em loop (máx. 200 lotes/execução) —
  nunca segura lock longo.
- **Reprocessamento:** retry do job BullMQ repete a transação inteira; como
  hoje, um job que falha após commit duplicaria contadores — comportamento
  pré-existente, não agravado.

## 9. Privacidade / LGPD

Este recurso muda o nível de identificação do analytics: passa a existir
**linha do tempo nominal** (userId + tela + horário) e modelo do aparelho.
Por isso:

- Só ligar com base legal clara (consentimento explícito dos usuários da VPS
  de teste, conforme combinado) e documentar no aviso de privacidade do app.
- Continuam proibidos: qualquer identificador bruto do aparelho, nome do
  aparelho, CPF, placa, chassi, coordenadas, texto livre (scanner de chaves +
  allowlists).
- Retenção limitada por TTL; aparelhos/vínculos guardam apenas hashes e modelo.
- Acesso somente por ADMIN via JWT; não há endpoint público.
- Para atender a um pedido de exclusão: `DELETE FROM AnalyticsJourneyEvent WHERE userId = ?`,
  `DELETE FROM AnalyticsUserDevice WHERE userId = ?` e `UPDATE AnalyticsDevice SET lastUserId = NULL WHERE lastUserId = ?`.

## 10. Limitações conhecidas

- **"Logado" é inferência** a partir dos summaries autenticados. Um aparelho
  que ficou 30 dias sem abrir o app aparece `INATIVO` mesmo com JWT válido
  (o token dura 300 dias). Para revogação real por aparelho é preciso
  `tokenVersion` no `user` + checagem no `JwtStrategy` — fora deste escopo.
- **Horário é o do aparelho** (validado ±5 min contra a janela do summary).
  `receivedAt` mostra quando o servidor recebeu.
- **Não há vínculo evento ↔ veículo**: `screen_rastreamento` não diz qual
  chassi foi consultado (chassi é chave proibida). Use `GET /vehicles/:id/events`
  (resolve pelas contas donas) ou cruze com os logs do nginx
  (`GET /api/rastreamento/ancora-status?chassi=…`).
- **Eventos chegam com atraso** de até 30 min (cadência do flush). Não é
  tempo real, por decisão (D1).
- IP do aparelho depende de `X-Forwarded-For` no nginx; sob CGNAT (Starlink,
  operadoras móveis) o IP identifica a operadora, não o assinante.

## 11. Playbook: investigação de acesso

Caso "quem abriu o rastreamento da placa X às 19:43 (BRT)":

1. Converter para UTC (+3h): 22:43. Janela sugerida 22:30–23:00.
2. `GET /api/analytics/journey/vehicles/TUJ7J72/events?from=…T22:30:00Z&to=…T23:00:00Z&event=screen_rastreamento`
   → lista conta, aparelho (`label`), `occurredAtBrt` e `durationMs`.
3. `GET /api/analytics/journey/users/<userId>/devices` → quantos aparelhos,
   modelo de cada um, status.
4. `GET /api/analytics/journey/users/<userId>/sessions?from=…&to=…&install=<prefixo>`
   → caminho completo daquela sessão (login → home → seleciona veículo →
   rastreamento…).
5. Se precisar do IP: `GET /devices/<installHash>` (`lastIp`) e cruzar com o
   nginx pelo horário.

## 12. Arquivos alterados/criados

| Arquivo | Mudança |
|---|---|
| `prisma/schema.prisma` | Modelos `AnalyticsDevice`, `AnalyticsUserDevice`, `AnalyticsJourneyEvent`, enum `AnalyticsJourneyEventType`; `journeyEventsCount` + 2 índices em `AnalyticsSummaryReceipt`. |
| `prisma/migrations/20260827142258_analytics_journey/migration.sql` | DDL correspondente. |
| `src/analytics/constants/analytics-journey.constants.ts` | Limites, tipos, nomes de job. |
| `src/analytics/constants/analytics-allowlists.ts` | `MAX_PAYLOAD_BYTES` 32 KB → 64 KB. |
| `src/analytics/dto/create-analytics-summary.dto.ts` | `AnalyticsDeviceInfoDto`, `AnalyticsJourneyEventDto`; campos opcionais `device`, `journey`. |
| `src/analytics/dto/analytics-journey-query.dto.ts` | Filtros das consultas. |
| `src/analytics/utils/analytics-journey.util.ts` (+ spec) | `sanitizeDeviceInfo`, `sanitizeJourney`. |
| `src/analytics/services/analytics.service.ts` | Ingestão: sanitiza e anexa `journey` ao job quando a flag está ligada. |
| `src/analytics/processors/analytics-ingest.processor.ts` | `persistJourney` na mesma transação; job `journey-cleanup`. |
| `src/analytics/services/analytics-journey.service.ts` | Consultas + agendamento da limpeza (`upsertJobScheduler`). |
| `src/analytics/controllers/analytics-journey.controller.ts` | Endpoints admin `/analytics/journey/*`. |
| `src/analytics/analytics.module.ts` | Registro do controller/service. |
| `src/analytics/services/analytics.service.spec.ts` | Testes da flag e do contrato aditivo. |
| `.env.example` | `ANALYTICS_JOURNEY_ENABLED`, `ANALYTICS_JOURNEY_TTL_DAYS`. |
