# Analytics Mobile — Documentação de Implementação

**Backend:** NestJS + Prisma + MySQL + Redis + BullMQ  
**App:** React Native / Expo SDK 55  
**Data:** 2026-06-23

---

## Sumário

1. [Decisões Arquiteturais](#1-decisões-arquiteturais)
2. [Árvore de Módulos](#2-árvore-de-módulos)
3. [Modelo de Banco de Dados](#3-modelo-de-banco-de-dados)
4. [Roteiro de Implementação no Frontend](#4-roteiro-de-implementação-no-frontend)
5. [Contratos de API](#5-contratos-de-api)
6. [Allowlists](#6-allowlists)
7. [Propriedades Proibidas](#7-propriedades-proibidas)
8. [Variáveis de Ambiente](#8-variáveis-de-ambiente)

---

## 1. Decisões Arquiteturais

### 1.1 Princípio fundamental: privacidade por design

O módulo de analytics foi projetado com **privacidade por padrão** e **sem coleta de PII (Personally Identifiable Information)**:

- Nenhum dado pessoal é aceito ou armazenado (CPF, e-mail, telefone, nome, placa etc.)
- `anonymous_install_id` e `session_id` enviados pelo app **nunca são persistidos** — o backend gera HMAC-SHA256 server-side com `ANALYTICS_SECRET` antes de qualquer escrita
- `userId` nunca é associado a eventos de analytics
- `raw_payload` não é salvo por padrão
- Campos pessoais detectados em qualquer nível do JSON causam rejeição HTTP 422

### 1.2 Summaries agregados, não eventos individuais

O app envia **summaries por período** (ex.: últimos 30 minutos), não um evento por clique. Isso reduz o volume de requisições e evita rastreamento granular de comportamento individual.

### 1.3 Fluxo assíncrono com BullMQ

```
App Mobile
    │
    ▼
POST /api/analytics/summaries
    │
    ├── Validações síncronas (tamanho, schema, chaves proibidas, datas)
    ├── Rate limit por IP (Redis)
    ├── Geração de HMAC (installHash, sessionHash)
    ├── Rate limit por installHash (Redis)
    ├── Filtro de allowlist + clamp de valores
    │
    ▼
BullMQ — analytics-summaries queue
    │
    ▼
AnalyticsIngestProcessor (worker assíncrono)
    │
    ├── Cria AnalyticsSummaryReceipt (recibo técnico)
    ├── Deduplicação de sessões/installs (tabelas auxiliares + unique constraint MySQL)
    └── Upserts nas tabelas agregadas diárias
```

**Por que BullMQ?** O projeto já usa a fila para webhooks, notificações e boletos. Seguir o mesmo padrão garante consistência, retry automático em falhas de banco e isolamento total do fluxo de analytics do fluxo principal da aplicação.

### 1.4 Rate limiting com ioredis direto

Como o projeto não usa `@nestjs/throttler`, o rate limit foi implementado com `ioredis` (já presente como dependência do BullMQ):

| Escopo | Janela | Limite |
|---|---|---|
| Por IP | 60 segundos | 10 requisições |
| Por installHash | 3600 segundos (1h) | 20 requisições |

### 1.5 Tabelas agregadas vs. eventos brutos

Em vez de armazenar um registro por evento (que escala mal), os dados são **consolidados por dia** em tabelas de agregação. Isso torna as queries de dashboard O(dias × telas) em vez de O(eventos totais).

### 1.6 Deduplicação de sessões e instalações

Para contar sessões e instalações únicas sem armazenar IDs brutos, foram criadas tabelas auxiliares (`AnalyticsDailyUniqueSession` e `AnalyticsDailyUniqueInstall`) com **unique constraints compostas**. A tentativa de inserção:

- Se bem-sucedida → incrementa o contador no `AnalyticsSessionDaily`
- Se falhar com violação de unique (já existe hoje) → não incrementa

Esse padrão é eficiente no MySQL e não requer Redis ou lógica de deduplicação em memória.

---

## 2. Árvore de Módulos

### 2.1 Posição na aplicação

```
src/
├── app.module.ts                        ← Registra AnalyticsModule
├── prisma.service.ts
├── main.ts
│
├── analytics/                           ← MÓDULO DE ANALYTICS
│   ├── analytics.module.ts
│   ├── analytics.controller.ts          ← POST /api/analytics/summaries
│   ├── analytics-dashboard.controller.ts ← GET /api/analytics/dashboard/*
│   ├── analytics.service.ts             ← Lógica de ingestão + dashboard
│   ├── analytics-ingest.processor.ts    ← Worker BullMQ
│   ├── analytics-redis.provider.ts      ← Provider ioredis para rate limit
│   │
│   ├── guards/
│   │   └── optional-jwt-auth.guard.ts   ← JWT opcional (aceita sem token)
│   │
│   ├── dto/
│   │   ├── create-analytics-summary.dto.ts
│   │   └── analytics-dashboard-query.dto.ts
│   │
│   ├── constants/
│   │   ├── analytics-allowlists.ts      ← Screens, actions, forms permitidos
│   │   └── analytics-prohibited-keys.ts ← 85 chaves proibidas
│   │
│   └── utils/
│       ├── analytics-hash.util.ts       ← HMAC-SHA256 e SHA-256
│       ├── prohibited-key-scanner.util.ts ← Varredura recursiva
│       └── analytics-sanitizer.util.ts  ← clampInt, sanitizeVersionString
│
├── queue/
│   └── queue.module.ts                  ← ANALYTICS_QUEUE adicionado aqui
│
└── auth/
    ├── jwt-auth.guard.ts                ← Usado nos endpoints de dashboard
    └── admin-role.guard.ts              ← Protege dashboard (role ADMIN)
```

### 2.2 Dependências do módulo

```
AnalyticsModule
 ├── imports
 │   ├── BullModule.registerQueue('analytics-summaries')
 │   ├── PassportModule
 │   └── JwtModule (para OptionalJwtAuthGuard)
 │
 ├── controllers
 │   ├── AnalyticsController
 │   └── AnalyticsDashboardController
 │
 └── providers
     ├── AnalyticsService
     ├── AnalyticsIngestProcessor
     ├── PrismaService
     └── analyticsRedisProvider (ioredis)
```

### 2.3 Adições em outros módulos

| Arquivo | Mudança |
|---|---|
| `src/app.module.ts` | `AnalyticsModule` adicionado aos imports |
| `src/queue/queue.module.ts` | `ANALYTICS_QUEUE = 'analytics-summaries'` exportado e registrado |
| `src/config/env.validator.ts` | `ANALYTICS_SECRET` adicionado às variáveis obrigatórias no boot |

---

## 3. Modelo de Banco de Dados

Todas as tabelas ficam no mesmo banco MySQL existente (`beneficios_api`). Migration: `prisma/migrations/20260622000000_add_analytics_tables/`.

### 3.1 `AnalyticsSummaryReceipt`

Recibo técnico mínimo de cada summary recebido. **Não armazena raw_payload.** TTL recomendado: 45 dias.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `receivedAt` | `DATETIME(3)` | Timestamp de recebimento no servidor |
| `periodStart` | `DATETIME(3)` | Início do período informado pelo app |
| `periodEnd` | `DATETIME(3)` | Fim do período informado pelo app |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app (ex.: `1.2.3`) |
| `runtimeVersion` | `VARCHAR(20)?` | Runtime do Expo (ex.: `1.0.0`) |
| `installHash` | `VARCHAR(64)` | HMAC-SHA256 do `anonymous_install_id` |
| `sessionHash` | `VARCHAR(64)` | HMAC-SHA256 do `session_id` |
| `acceptedScreensCount` | `INT` | Quantidade de screens aceitas após filtro |
| `acceptedActionsCount` | `INT` | Quantidade de actions aceitas após filtro |
| `acceptedFormsCount` | `INT` | Quantidade de forms aceitos após filtro |
| `discardedItemsCount` | `INT` | Itens descartados por não estar na allowlist |
| `validationStatus` | `VARCHAR(20)` | `ACCEPTED` ou `PARTIAL` |
| `payloadHash` | `VARCHAR(64)` | SHA-256 do payload sanitizado (idempotência) |
| `createdAt` | `DATETIME(3)` | Criado em |

**Índices:** `receivedAt`, `periodStart`, `platform`, `appVersion`, `payloadHash`

---

### 3.2 `AnalyticsScreenDaily`

Agregado diário de visualizações de telas. TTL recomendado: 12–24 meses.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `day` | `DATE` | Dia do agregado (baseado em `period_start`) |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app |
| `screen` | `VARCHAR(60)` | Identificador da tela (ex.: `screen_home`) |
| `viewCount` | `INT` | Total de visualizações acumuladas no dia |
| `totalTimeMs` | `INT` | Tempo total em ms acumulado no dia |
| `createdAt` / `updatedAt` | `DATETIME(3)` | — |

**Unique:** `(day, platform, appVersion, screen)`  
**Upsert:** soma `viewCount` e `totalTimeMs` aos valores existentes.

---

### 3.3 `AnalyticsActionDaily`

Agregado diário de ações do app. TTL recomendado: 12–24 meses.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `day` | `DATE` | Dia do agregado |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app |
| `action` | `VARCHAR(60)` | Identificador da ação (ex.: `auth_login_success`) |
| `count` | `INT` | Total de ocorrências acumuladas no dia |
| `createdAt` / `updatedAt` | `DATETIME(3)` | — |

**Unique:** `(day, platform, appVersion, action)`

---

### 3.4 `AnalyticsFormDaily`

Agregado diário de interações com formulários. TTL recomendado: 12–24 meses.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `day` | `DATE` | Dia do agregado |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app |
| `screen` | `VARCHAR(60)` | Tela onde o formulário aparece |
| `form` | `VARCHAR(60)` | Identificador do formulário |
| `startedCount` | `INT` | Vezes que o usuário iniciou o preenchimento |
| `submittedCount` | `INT` | Vezes que submeteu |
| `successCount` | `INT` | Submissões com sucesso |
| `errorCount` | `INT` | Submissões com erro |
| `createdAt` / `updatedAt` | `DATETIME(3)` | — |

**Unique:** `(day, platform, appVersion, screen, form)`

---

### 3.5 `AnalyticsSessionDaily`

Contagem diária de sessões e instalações únicas. TTL recomendado: 12–24 meses.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `day` | `DATE` | Dia do agregado |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app |
| `sessionsCount` | `INT` | Sessões únicas no dia (por `sessionHash`) |
| `installsCount` | `INT` | Installs únicos no dia (por `installHash`) |
| `createdAt` / `updatedAt` | `DATETIME(3)` | — |

**Unique:** `(day, platform, appVersion)`

---

### 3.6 `AnalyticsDailyUniqueSession` *(tabela auxiliar)*

Garante que uma sessão não seja contada mais de uma vez por dia. TTL recomendado: 45–90 dias.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `day` | `DATE` | Dia |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app |
| `sessionHash` | `VARCHAR(64)` | HMAC do `session_id` |
| `createdAt` | `DATETIME(3)` | — |

**Unique:** `(day, platform, appVersion, sessionHash)`

---

### 3.7 `AnalyticsDailyUniqueInstall` *(tabela auxiliar)*

Garante que uma instalação não seja contada mais de uma vez por dia. TTL recomendado: 45–90 dias.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `INT AUTO_INCREMENT` | PK |
| `day` | `DATE` | Dia |
| `platform` | `VARCHAR(10)` | `ios` ou `android` |
| `appVersion` | `VARCHAR(20)` | Versão do app |
| `installHash` | `VARCHAR(64)` | HMAC do `anonymous_install_id` |
| `createdAt` | `DATETIME(3)` | — |

**Unique:** `(day, platform, appVersion, installHash)`

---

## 4. Roteiro de Implementação no Frontend

### 4.1 Visão geral da estratégia

O app **não envia um evento por ação**. Em vez disso, mantém contadores locais e envia um **summary consolidado por período** (ex.: a cada 30 minutos ou no background/foreground do app).

```
┌──────────────────────────────────────────┐
│         App React Native / Expo          │
│                                          │
│  AnalyticsTracker (singleton)            │
│  ├── screenTimers: Map<screen, start>    │
│  ├── screenCounts: Map<screen, count>    │
│  ├── actionCounts: Map<action, count>    │
│  ├── formStats: Map<form, stats>         │
│  └── sessionId / anonymousInstallId      │
│                                          │
│  Dispara summary a cada ~30min           │
│  ou ao entrar em background              │
└──────────────┬───────────────────────────┘
               │ POST /api/analytics/summaries
               ▼
         Backend NestJS
```

### 4.2 Geração e persistência dos identificadores

#### `anonymous_install_id`

- Gerado **uma única vez** na primeira abertura do app
- Deve ser um **UUID v4 aleatório**
- Persistido com `expo-secure-store` (não `AsyncStorage`)
- **Nunca enviado para outros endpoints**
- **Nunca vinculado ao usuário logado**

```typescript
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const INSTALL_ID_KEY = 'analytics_install_id';

async function getOrCreateInstallId(): Promise<string> {
  let id = await SecureStore.getItemAsync(INSTALL_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(INSTALL_ID_KEY, id);
  }
  return id;
}
```

#### `session_id`

- Gerado **a cada abertura do app** (AppState `active` vindo de `background`/`inactive`)
- Também um **UUID v4 aleatório**
- Mantido apenas em memória (não persistido)
- Regenerado após 30 minutos de inatividade ou ao reabrir o app

```typescript
import * as Crypto from 'expo-crypto';

let currentSessionId = Crypto.randomUUID();

// Ao voltar do background:
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    currentSessionId = Crypto.randomUUID();
  }
});
```

### 4.3 Rastreamento de tempo por tela

Use `useFocusEffect` (React Navigation) para marcar entrada e saída de tela:

```typescript
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef } from 'react';

function useScreenTracking(screenName: string) {
  const enteredAt = useRef<number>(0);

  useFocusEffect(
    useCallback(() => {
      enteredAt.current = Date.now();
      analyticsTracker.onScreenEnter(screenName);

      return () => {
        const elapsed = Date.now() - enteredAt.current;
        analyticsTracker.onScreenExit(screenName, elapsed);
      };
    }, [screenName]),
  );
}
```

### 4.4 Rastreamento de ações

Chame diretamente após a ação acontecer:

```typescript
// Login bem-sucedido
analyticsTracker.trackAction('auth_login_success');

// Erro de login
analyticsTracker.trackAction('auth_login_error');

// Biometria
analyticsTracker.trackAction('auth_biometric_success');

// Boleto copiado
analyticsTracker.trackAction('boleto_copied');
```

### 4.5 Rastreamento de formulários

```typescript
// Ao focar o primeiro campo
analyticsTracker.trackFormStarted('screen_login', 'form_login');

// Ao submeter
analyticsTracker.trackFormSubmitted('screen_login', 'form_login');

// Ao receber resposta de sucesso
analyticsTracker.trackFormSuccess('screen_login', 'form_login');

// Ao receber erro
analyticsTracker.trackFormError('screen_login', 'form_login');
```

### 4.6 Envio do summary

Envie no período configurado (**não no momento do evento**):

```typescript
// Exemplo simplificado do tracker
class AnalyticsTracker {
  private periodStart = new Date();
  private screenCounts = new Map<string, number>();
  private screenTimeMs = new Map<string, number>();
  private actionCounts = new Map<string, number>();
  private formStats = new Map<string, FormStats>();

  async flush(): Promise<void> {
    const periodEnd = new Date();

    // Monta payload
    const payload: AnalyticsSummaryPayload = {
      period_start: this.periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      app: {
        platform: Platform.OS as 'ios' | 'android',
        version: Constants.expoConfig?.version ?? '0.0.0',
        runtime_version: Updates.runtimeVersion ?? undefined,
      },
      session: {
        session_id: currentSessionId,
        anonymous_install_id: await getOrCreateInstallId(),
      },
      screens: Array.from(this.screenCounts.entries()).map(([screen, view_count]) => ({
        screen,
        view_count,
        total_time_ms: this.screenTimeMs.get(screen) ?? 0,
      })),
      actions: Array.from(this.actionCounts.entries()).map(([action, count]) => ({
        action,
        count,
      })),
      forms: Array.from(this.formStats.entries()).map(([key, stats]) => {
        const [screen, form] = key.split('::');
        return { screen, form, ...stats };
      }),
    };

    try {
      await api.post('/analytics/summaries', payload);
    } catch {
      // Falha silenciosa — analytics nunca impacta o fluxo principal
    } finally {
      this.reset(periodEnd);
    }
  }
}
```

### 4.7 Quando enviar

| Gatilho | Ação |
|---|---|
| App vai para background (`AppState`) | `tracker.flush()` |
| App fecha | `tracker.flush()` |
| Timer de 30 minutos (`setInterval`) | `tracker.flush()` |
| Login bem-sucedido | Registrar ação, **não** flush imediato |
| Erro de login | Registrar ação, **não** flush imediato |

> **Importante:** não fazer flush a cada ação. O objetivo é um summary por período.

### 4.8 Telas que precisam de analytics antes do login

As telas `screen_login`, `screen_primeiro_acesso` e erros de autenticação precisam de rastreamento **antes** do usuário estar autenticado. Isso é suportado: o endpoint **não exige Authorization**.

O tracker deve funcionar desde a abertura do app, independentemente do estado de autenticação.

---

## 5. Contratos de API

### 5.1 Ingestão de Summary

```
POST /api/analytics/summaries
```

**Authorization:** Opcional. Aceita sem token JWT.  
**Content-Type:** `application/json`  
**Tamanho máximo:** 32 KB

#### Request body

```jsonc
{
  "period_start": "2024-01-15T14:00:00.000Z",  // ISO 8601, obrigatório
  "period_end":   "2024-01-15T14:28:00.000Z",  // ISO 8601, obrigatório

  "app": {
    "platform":        "android",   // "ios" | "android", obrigatório
    "version":         "1.2.3",     // string, max 20 chars, obrigatório
    "runtime_version": "1.0.0"      // string, max 20 chars, opcional
  },

  "session": {
    "session_id":           "a1b2c3d4-e5f6-4789-abcd-ef0123456789", // UUID v4, obrigatório
    "anonymous_install_id": "b2c3d4e5-f6a7-4890-bcde-f01234567890"  // UUID v4, obrigatório
  },

  "screens": [           // array, max 30 itens, obrigatório (pode ser vazio)
    {
      "screen":       "screen_home",  // string da allowlist (ver seção 6)
      "view_count":   3,              // int >= 0, clampado em 9999
      "total_time_ms": 45000          // int >= 0 em ms, clampado em 3600000
    }
  ],

  "actions": [           // array, max 40 itens, obrigatório (pode ser vazio)
    {
      "action": "auth_login_success", // string da allowlist (ver seção 6)
      "count":  1                      // int >= 0, clampado em 9999
    }
  ],

  "forms": [             // array, max 5 itens, OPCIONAL
    {
      "screen":          "screen_login", // tela do formulário
      "form":            "form_login",   // identificador da allowlist (ver seção 6)
      "started_count":   1,              // int >= 0, clampado em 9999
      "submitted_count": 1,
      "success_count":   1,
      "error_count":     0
    }
  ]
}
```

#### Regras de validação

| Campo | Regra |
|---|---|
| `period_start` | ISO 8601 válido |
| `period_end` | ISO 8601 válido, posterior a `period_start` |
| `period_end - period_start` | ≤ 1 hora (3.600.000 ms) |
| `app.platform` | Exatamente `"ios"` ou `"android"` |
| `session.session_id` | UUID v4 válido |
| `session.anonymous_install_id` | UUID v4 válido |
| Qualquer chave | Não pode estar na lista de proibidas (seção 7) |
| Screens fora da allowlist | Descartadas, payload aceito |
| Actions fora da allowlist | Descartadas, payload aceito |
| Forms fora da allowlist | Descartados, payload aceito |

#### Responses

| Status | Quando |
|---|---|
| `202 Accepted` | Payload aceito e enfileirado |
| `400 Bad Request` | JSON malformado |
| `422 Unprocessable Entity` | Schema inválido, datas inválidas, propriedade proibida |
| `429 Too Many Requests` | Rate limit excedido |
| `500 Internal Server Error` | Erro inesperado (sem detalhes expostos) |

**Resposta 202:**
```json
{ "message": "accepted" }
```

**Resposta 422:**
```json
{
  "statusCode": 422,
  "message": "Payload com schema inválido"
}
```

---

### 5.2 Dashboard — Overview

```
GET /api/analytics/dashboard/overview
```

**Authorization:** Bearer JWT obrigatório (role ADMIN)

#### Query params

| Param | Tipo | Obrigatório | Default | Descrição |
|---|---|---|---|---|
| `from` | ISO 8601 date | Não | 30 dias atrás | Data inicial |
| `to` | ISO 8601 date | Não | hoje | Data final |
| `platform` | `ios` \| `android` | Não | — | Filtrar por plataforma |
| `app_version` | string | Não | — | Filtrar por versão |

**Restrições:** `to >= from`, intervalo máximo 12 meses.

#### Response `200 OK`

```json
{
  "totalSessions": 1420,
  "totalInstalls": 312,
  "totalLoginSuccess": 1380,
  "totalLoginError": 42,
  "totalLogout": 210,
  "totalBiometricSuccess": 890,
  "totalBiometricError": 15,
  "totalCouponRedeemSuccess": 67,
  "totalCouponRedeemError": 4,
  "totalInspectionStarted": 23,
  "totalInspectionSubmitted": 18,
  "totalInspectionError": 5,
  "totalSosPhoneTriggered": 12,
  "totalSosWhatsappTriggered": 8,
  "topScreens": [
    {
      "screen": "screen_home",
      "viewCount": 4210,
      "totalTimeMs": 12630000,
      "avgTimeMs": 2999
    }
  ],
  "topActions": [
    { "action": "auth_login_success", "count": 1380 }
  ]
}
```

---

### 5.3 Dashboard — Screens

```
GET /api/analytics/dashboard/screens
```

**Authorization:** Bearer JWT obrigatório (role ADMIN)  
**Query params:** mesmos do overview (`from`, `to`, `platform`, `app_version`)

#### Response `200 OK`

```json
[
  {
    "screen":      "screen_home",
    "viewCount":   4210,
    "totalTimeMs": 12630000,
    "avgTimeMs":   2999
  },
  {
    "screen":      "screen_beneficios",
    "viewCount":   1840,
    "totalTimeMs": 4600000,
    "avgTimeMs":   2500
  }
]
```

Ordenado por `viewCount` decrescente.

---

### 5.4 Dashboard — Actions

```
GET /api/analytics/dashboard/actions
```

**Authorization:** Bearer JWT obrigatório (role ADMIN)  
**Query params:** mesmos do overview

#### Response `200 OK`

```json
[
  { "action": "auth_login_success", "count": 1380 },
  { "action": "auth_biometric_success", "count": 890 },
  { "action": "boleto_copied", "count": 214 }
]
```

Ordenado por `count` decrescente.

---

### 5.5 Dashboard — Forms

```
GET /api/analytics/dashboard/forms
```

**Authorization:** Bearer JWT obrigatório (role ADMIN)  
**Query params:** mesmos do overview

#### Response `200 OK`

```json
[
  {
    "screen":          "screen_login",
    "form":            "form_login",
    "startedCount":    1450,
    "submittedCount":  1400,
    "successCount":    1380,
    "errorCount":      20,
    "successRate":     98.57,
    "errorRate":       1.43
  }
]
```

`successRate` e `errorRate` são percentuais baseados em `submittedCount`.

---

### 5.6 Dashboard — Sessions

```
GET /api/analytics/dashboard/sessions
```

**Authorization:** Bearer JWT obrigatório (role ADMIN)  
**Query params:** mesmos do overview

#### Response `200 OK`

```json
[
  {
    "day":           "2024-01-15",
    "platform":      "android",
    "appVersion":    "1.2.3",
    "sessionsCount": 48,
    "installsCount": 12
  },
  {
    "day":           "2024-01-15",
    "platform":      "ios",
    "appVersion":    "1.2.3",
    "sessionsCount": 31,
    "installsCount": 7
  }
]
```

Ordenado por `day` crescente. Cada linha representa uma combinação única de dia + plataforma + versão.

---

## 6. Allowlists

### 6.1 Screens (25 telas)

```
screen_login                screen_primeiro_acesso       screen_trocar_senha
screen_home                 screen_selecionar_veiculo    screen_combustivel
screen_beneficios           screen_beneficios_veiculo    screen_meus_cupons
screen_ofertas              screen_beneficio_categoria   screen_beneficio_organizacao
screen_documentos           screen_financeiro            screen_telemedicina
screen_odonto               screen_pet                   screen_sos
screen_oficinas             screen_rastreamento          screen_monitoramento_rotas
screen_revistoria_iniciar   screen_revistoria_fotos      screen_revistoria_status
screen_perfil
```

### 6.2 Actions (33 ações)

```
auth_login_success          auth_login_error             auth_logout
auth_biometric_success      auth_biometric_error         auth_primeiro_acesso_submit
auth_password_changed       vehicle_selected             fuel_station_viewed
fuel_card_opened            fuel_filter_applied          benefit_category_opened
benefit_organization_opened coupon_redeem_success        coupon_redeem_error
offer_opened                document_opened              sos_phone_triggered
sos_whatsapp_triggered      workshop_contact_triggered   boleto_copied
boleto_shared               inspection_started           inspection_photo_captured
inspection_submitted        inspection_error             tracking_period_selected
webview_telemedicina_opened webview_odonto_opened        webview_pet_opened
notification_opened         drawer_opened
```

### 6.3 Forms (4 formulários)

```
form_login    form_primeiro_acesso    form_trocar_senha    form_revistoria
```

> Itens enviados fora dessas listas são **descartados silenciosamente** — o restante do payload é aceito normalmente.

---

## 7. Propriedades Proibidas

Qualquer chave equivalente às listadas abaixo — em qualquer nível do JSON, em qualquer capitalização (camelCase, snake_case, kebab-case) — causa rejeição **HTTP 422** de todo o payload.

```
cpf, cnpj, email, phone, telefone, celular
password, senha, pwd, pass
name, nome, sobrenome, fullname, full_name, username, usuario
placa, plate, chassi, chassis, renavam, vin, numero_motor
address, endereco, rua, logradouro, cidade, city
estado, state, cep, zipcode, zip, bairro, district
latitude, longitude, lat, lng, location, coords, geopoint
token, jwt, bearer, access_token, refresh_token
expoPushToken, push_token
device_id, advertising_id, idfa, gaid, android_id
fingerprint, imei, device_fingerprint
user_id, userId, associado_id
url, uri, src, href, title, label
filename, file_name, photo, image, imagem, foto
base64, blob, file, document, documento
qrcode, qr_code, barcode
cpf_hash, email_hash, phone_hash, placa_hash, user_hash, hashed_cpf, hashed_email
value, text
```

**Normalização aplicada:** a chave `UserId`, `USER_ID` e `user-id` são todas equivalentes a `user_id`.

---

## 8. Variáveis de Ambiente

Adicionar ao `.env` do projeto:

```dotenv
# Analytics — obrigatório no boot (app não sobe sem esta variável)
ANALYTICS_SECRET=<segredo_forte_minimo_32_chars>

# Controles opcionais (valores default abaixo)
ANALYTICS_DEBUG_PAYLOADS_ENABLED=false
ANALYTICS_RECEIPTS_TTL_DAYS=45
ANALYTICS_DEBUG_PAYLOAD_TTL_DAYS=7
ANALYTICS_RATE_LIMIT_ENABLED=true
```

> `ANALYTICS_SECRET` deve ser uma string aleatória de no mínimo 32 caracteres. Em produção, use um gerador seguro como `openssl rand -hex 32`.

---

## Considerações de LGPD

| Aspecto | Abordagem |
|---|---|
| Dados pessoais | Não coletados — qualquer campo pessoal rejeitado na entrada |
| Identificadores | `anonymous_install_id` e `session_id` transformados via HMAC antes de persistir |
| Vinculação ao usuário | Inexistente — analytics não tem FK com tabela `user` |
| Raw payload | Não armazenado por padrão |
| Retenção | Receipts: 45 dias; Agregados: 12–24 meses; Aux. dedup: 45–90 dias |
| Dados de localização | Campos `lat`, `lng`, `latitude`, `longitude`, `coords`, `location` bloqueados |
