# Analytics Dashboard — Prompt para Lovable

## Contexto do Projeto

Preciso criar um dashboard web de analytics para um app mobile (Android/iOS) desenvolvido em React Native / Expo. O backend é uma API REST NestJS já implementada que expõe endpoints de consulta. O frontend deve consumir essa API e exibir métricas de uso do app de forma clara e visual.

---

## Stack Técnica

- Framework: React com TypeScript
- Estilização: Tailwind CSS + shadcn/ui
- Gráficos: Recharts
- HTTP Client: axios (com interceptor de Authorization Bearer)
- Gerenciamento de estado de auth: Zustand ou Context API
- Roteamento: React Router v6
- Formatação de datas: date-fns

---

## Autenticação

### Login
**POST** `{API_BASE_URL}/api/admin-panel/auth/login`

Request body:
```json
{ "email": "string", "password": "string" }
```

Response 200:
```json
{
  "access_token": "eyJ...",
  "user": {
    "id": 1,
    "name": "Samuel",
    "email": "admin@example.com",
    "role": "MARKETING"
  }
}
```

- Salvar `access_token` no localStorage (chave: `analytics_token`)
- Salvar `user` no localStorage (chave: `analytics_user`)
- Todas as requisições aos endpoints de dashboard devem incluir o header:
  `Authorization: Bearer {access_token}`
- Ao receber 401 ou 403, limpar localStorage e redirecionar para /login

---

## Variável de Ambiente

Criar arquivo `.env`:
```
VITE_API_BASE_URL=http://localhost:3001
```

---

## Rotas da Aplicação

```
/login              → Tela de login
/                   → Redireciona para /dashboard
/dashboard          → Overview geral
/dashboard/screens  → Telas mais acessadas
/dashboard/actions  → Ações do app
/dashboard/forms    → Métricas de formulários
/dashboard/sessions → Série temporal de sessões
```

Todas as rotas (exceto /login) são protegidas: se não houver token, redirecionar para /login.

---

## Componente de Filtros Globais (persistido em URL query params)

Todos os endpoints de dashboard aceitam os mesmos query params opcionais:
- `from` — data inicial (ISO 8601 date string, ex: `2026-06-01`)
- `to` — data final (ISO 8601 date string, ex: `2026-07-06`)
- `platform` — `ios` | `android` (opcional)
- `app_version` — string (opcional, ex: `1.1.6`)

O filtro deve ter:
- Date range picker (from / to) com preset rápidos: "Últimos 7 dias", "Últimos 30 dias", "Últimos 90 dias"
- Select de plataforma: Todas / iOS / Android
- Input de versão do app (texto livre)
- Botão "Aplicar filtros"
- Default: últimos 30 dias, sem filtro de plataforma ou versão

---

## Endpoints de Dashboard

Todos requerem `Authorization: Bearer {token}` e retornam 200 com JSON.
Base: `{VITE_API_BASE_URL}/api/analytics/dashboard`

---

### 1. Overview — GET /overview

Usado em: `/dashboard`

Response:
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
    { "screen": "screen_home", "viewCount": 4210, "totalTimeMs": 12630000, "avgTimeMs": 2999 }
  ],
  "topActions": [
    { "action": "auth_login_success", "count": 1380 }
  ]
}
```

**Layout `/dashboard`:**

Linha 1 — KPI Cards (grid 2 colunas no mobile, 4 no desktop):
- Sessões totais (ícone: activity)
- Instalações únicas (ícone: download)
- Logins com sucesso (ícone: check-circle) — verde
- Erros de login (ícone: x-circle) — vermelho

Linha 2 — KPI Cards menores (grid 2 ou 4 colunas):
- Biometria OK
- Biometria com erro
- Cupons resgatados
- Erros de resgate

Linha 3 — KPI Cards menores:
- Revistoria iniciada
- Revistoria enviada
- SOS Telefone
- SOS WhatsApp

Linha 4 — dois painéis lado a lado:
- Tabela "Top 10 Telas" (screen, visualizações, tempo médio em segundos)
- Tabela "Top 10 Ações" (action, contagem)

---

### 2. Telas — GET /screens

Usado em: `/dashboard/screens`

Response:
```json
[
  { "screen": "screen_home", "viewCount": 4210, "totalTimeMs": 12630000, "avgTimeMs": 2999 }
]
```

Ordenado por viewCount desc (já vem ordenado do backend).

**Layout `/dashboard/screens`:**
- Gráfico de barras horizontais (Recharts BarChart horizontal) mostrando `viewCount` por tela — top 15
- Tabela completa abaixo com: Tela | Visualizações | Tempo total (min) | Tempo médio (s)
- `totalTimeMs` deve ser convertido para minutos no display
- `avgTimeMs` deve ser exibido em segundos com 1 casa decimal
- Nomes de tela: remover prefixo `screen_` e capitalizar (ex: `screen_home` → `Home`)

---

### 3. Ações — GET /actions

Usado em: `/dashboard/actions`

Response:
```json
[
  { "action": "auth_login_success", "count": 1380 }
]
```

Ordenado por count desc.

**Layout `/dashboard/actions`:**
- Gráfico de barras verticais (Recharts BarChart) com top 10 ações
- Tabela completa com: Ação | Contagem | Percentual do total
- Nomes de ação: substituir `_` por espaço e capitalizar cada palavra.
  Ex: `auth_login_success` → `Auth Login Success`
- Agrupar visualmente por categoria (prefixo): `auth_`, `boleto_`, `coupon_`, `inspection_`, `sos_`, `tracking_`, `webview_`, etc.

---

### 4. Formulários — GET /forms

Usado em: `/dashboard/forms`

Response:
```json
[
  {
    "screen": "screen_login",
    "form": "form_login",
    "startedCount": 1450,
    "submittedCount": 1400,
    "successCount": 1380,
    "errorCount": 20,
    "successRate": 98.57,
    "errorRate": 1.43
  }
]
```

**Layout `/dashboard/forms`:**
- Cards por formulário (um card para cada item do array)
- Cada card mostra:
  - Título: nome do formulário sem prefixo `form_`, capitalizado
  - Subtítulo: tela de origem sem prefixo `screen_`
  - 4 métricas em grid 2x2: Iniciados | Submetidos | Sucesso | Erros
  - Barra de progresso para `successRate` — verde
  - Barra de progresso para `errorRate` — vermelho
  - Taxa de conclusão = `submittedCount / startedCount * 100` (calcular no frontend)

---

### 5. Sessões — GET /sessions

Usado em: `/dashboard/sessions`

Response:
```json
[
  {
    "day": "2026-07-01",
    "platform": "android",
    "appVersion": "1.1.6",
    "sessionsCount": 48,
    "installsCount": 12
  }
]
```

**Layout `/dashboard/sessions`:**
- Gráfico de linha (Recharts LineChart) com:
  - Eixo X: dia (formato `dd/MM`)
  - Linha 1 (azul): sessões diárias — agregadas pelo frontend se houver múltiplas plataformas/versões no mesmo dia
  - Linha 2 (verde): instalações diárias
  - Tooltip mostrando dia, sessões e instalações
  - Legenda
- Tabela abaixo com: Dia | Plataforma | Versão | Sessões | Instalações
- Se não houver filtro de plataforma ativo, mostrar ambas as plataformas agrupadas por dia no gráfico (somar `sessionsCount` e `installsCount` do mesmo dia)

---

## Tratamento de Loading e Erros

- Skeleton loaders nos cards e tabelas enquanto carrega
- Componente de erro com mensagem e botão "Tentar novamente" quando a API retornar erro
- Toast de erro (shadcn/ui Toaster) quando qualquer requisição falhar
- Se a resposta vier com array vazio, exibir estado vazio com ícone e mensagem "Nenhum dado no período selecionado"

---

## Navegação e Layout

**Sidebar fixa (desktop) / bottom nav (mobile):**
- Logo "Analytics" no topo
- Itens de menu:
  - Overview (ícone: layout-dashboard)
  - Telas (ícone: monitor)
  - Ações (ícone: zap)
  - Formulários (ícone: file-text)
  - Sessões (ícone: users)
- Footer da sidebar: nome do usuário logado + botão Sair

**Header:**
- Título da página atual
- Componente de filtros globais (descrito acima)

**Paleta de cores:**
- Primária: `#6366f1` (indigo-500)
- Sucesso: `#22c55e` (green-500)
- Perigo: `#ef4444` (red-500)
- Fundo: `#f8fafc` (slate-50)
- Cards: branco com borda `#e2e8f0`

---

## Funções Utilitárias de Formatação

```typescript
function formatScreenName(screen: string): string {
  return screen
    .replace(/^screen_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatActionName(action: string): string {
  return action
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('pt-BR');
}
```

---

## Estrutura de Arquivos Sugerida

```
src/
  api/
    client.ts          ← axios instance com interceptor de auth
    analytics.ts       ← getOverview, getScreens, getActions, getForms, getSessions
    auth.ts            ← login
  components/
    layout/
      Sidebar.tsx
      Header.tsx
      FilterBar.tsx
    shared/
      KpiCard.tsx
      DataTable.tsx
      EmptyState.tsx
      LoadingSkeleton.tsx
  pages/
    LoginPage.tsx
    OverviewPage.tsx
    ScreensPage.tsx
    ActionsPage.tsx
    FormsPage.tsx
    SessionsPage.tsx
  hooks/
    useAnalytics.ts    ← React Query hooks para cada endpoint
    useFilters.ts      ← lê/grava filtros em URL query params
  store/
    auth.ts            ← Zustand store para token e user
  types/
    analytics.ts       ← interfaces TypeScript para todos os responses
  App.tsx
  main.tsx
```

---

## Requisitos Extras

1. Responsivo (funciona em tablet e desktop; mobile secundário)
2. Os filtros devem ser sincronizados com a URL (query params) para que links possam ser compartilhados
3. Ao trocar de página, os filtros devem persistir
4. Usar React Query (TanStack Query) para cache e revalidação automática dos dados
5. Refresh automático a cada 5 minutos quando a aba estiver ativa (`refetchInterval: 5 * 60 * 1000`)
6. Números grandes formatados com separador de milhar em pt-BR: `1420` → `1.420`
7. Tempo em ms convertido de forma legível: `12630000` → `3h 30m`
