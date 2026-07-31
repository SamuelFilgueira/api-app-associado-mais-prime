# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

```bash
npm run start:dev          # dev com watch (porta 3001 por padrão)
npm run build              # nest build -> dist/
npm run start:prod         # node dist/main
npm run lint               # eslint --fix em {src,apps,libs,test}/**/*.ts
npm run format             # prettier

npm test                   # jest (rootDir: src, testRegex: *.spec.ts)
npm run test:watch
npm run test:cov
npm run test:e2e           # jest --config ./test/jest-e2e.json (*.e2e-spec.ts)

# um único arquivo / um único caso
npx jest src/analytics/analytics.service.spec.ts
npx jest -t "nome do teste"

# Prisma (não há scripts npm — usar o CLI direto)
npx prisma generate
npx prisma migrate dev --name descricao_da_mudanca
npx prisma studio

docker compose up --build  # sobe redis + api (api usa REDIS_HOST=redis)
```

Swagger em `/docs`. Health check em `/health` (único endpoint fora do prefixo global `/api`).

## Arquitetura

NestJS 11 (monolito modular) + Prisma/MySQL + Redis/BullMQ. `src/main.ts` define: `TZ=America/Sao_Paulo`, validação de env antes do boot, prefixo global `/api`, `ValidationPipe({ whitelist: true, transform: true })`, `LoggingInterceptor`, `HttpExceptionFilter`, limite de payload de 20mb (fotos em base64) e `/uploads` servido estaticamente.

### Multi-tenant por `baseOrigin` — conceito central

Toda a API atende duas bases: `MAIS_PRIME` e `MAIS_PRIME_RS`. A base vem no **JWT** (`payload.baseOrigin`, gravada em `AuthService.login`) e determina qual credencial de cada API externa será usada.

- `src/shared/token-resolver.service.ts` — resolve `BaseOrigin` → **nomes de variáveis de ambiente** (SGA, Lógica, Softruck, M7, Clubgas, Alloyal) via `src/config/tenant.config.ts`. Ao adicionar qualquer integração nova, é obrigatório preencher a entrada nas **duas** bases.
- `src/shared/base-context.service.ts` — `@Injectable({ scope: Scope.REQUEST })`, lê `request.user.baseOrigin` e resolve os tokens. Serviços que dependem dele herdam o escopo REQUEST.
- `src/shared/sga-auth.service.ts` — autenticação na Hinova/SGA com cache de `token_usuario` por base, dedupe de requisições em voo e reautenticação automática em 401 (`executeWithAuth` / `executeRequestWithAuth`).
- `maskSecret` / `baseTag` vivem em `src/shared/log.util.ts`; nunca logar valores de token.

`SharedModule` é `@Global()` e é importado explicitamente no `AppModule`.

### Estrutura padrão por módulo

Cada módulo de domínio segue a mesma organização de pastas: `controllers/`, `services/`, `dto/` e, quando aplicável, `guards/`, `processors/`, `strategies/`, `interfaces/`, `repositories/`, `enums/`, `decorators/`. O `*.module.ts` fica na raiz do módulo. O `AppModule` contém **apenas imports de módulos** — nunca declarar controllers/providers de feature nele.

Transversais: `src/database/` (PrismaService — instância única global), `src/infra/` (mail/, storage/ com `FileUploadService`, decorators/, filters/, interceptors/, health/), `src/integrations/` (um client HTTP por vendor externo; `clubgas/` é o modelo — resolve token por base internamente, controllers não fazem resolução de credencial), `src/shared/` (tenancy + SGA auth + log utils), `src/queue/`.

### Módulos globais

`DatabaseModule` (PrismaService), `InfraModule` (MailService + FileUploadService + HealthController), `QueueModule` (BullMQ/Redis), `SharedModule`. **Nunca redeclarar** esses providers em módulos de feature — isso cria instâncias/pools duplicados.

### Filas (BullMQ)

Nomes exportados de `src/queue/queue.module.ts`: `WEBHOOK_QUEUE`, `NOTIFICATION_QUEUE`, `FUEL_ECONOMY_QUEUE`, `BOLETO_VERIFICACAO_QUEUE`, `ANALYTICS_QUEUE`. Padrão: o controller enfileira e responde imediatamente; um `WorkerHost` (`*.processor.ts`) faz o trabalho pesado com retry/backoff. Ex.: `POST /rastreamento/webhook-m7` → `WebhookProcessor` → `RastreamentoService.processarWebhookM7`.

### Rastreamento (`src/rastreamento`)

Três provedores externos: **M7**, **Lógica Soluções** e **Softruck**, cada um com subpasta própria (`m7/`, `logica/`, `softruck/`) organizada em `controllers/ services/ dto/ helpers/ mappers/ pdf/`. Os clients ficam em `m7/services/rastreamento-m7.ts`, `logica/services/rastreamento.logica.ts` e `softruck/services/rastreamento-softruck.service.ts`; a orquestração fica em `services/rastreamento.service.ts`. `RastreamentoService.rastreamento()` consulta os provedores em paralelo com `Promise.allSettled` e escolhe a posição mais recente.

- Novo provedor: implementar `IRastreamentoProvider` (`providers/rastreamento-provider.interface.ts`) e registrar em `rastreamento.module.ts`.
- `RastreamentoM7` e `LogicaRastreamentoService` são injetados pelo Nest — não instanciar com `new`.
- Relatórios PDF de histórico/trajetos usam Puppeteer (no Docker, Chromium do sistema via `PUPPETEER_EXECUTABLE_PATH`).

### Autenticação e autorização

- `JwtAuthGuard` / `LocalAuthGuard` (Passport) — usuários do app.
- `PrimeiroLoginGuard` — bloqueia rotas enquanto `user.primeiroLogin === true` (exceto a troca de senha).
- `AdminRoleGuard` — exige `role === ADMIN` no JWT.
- `AdminPanelRoleGuard` + `@AdminPanelRoles(...)` — painel administrativo (`AdminPanelRole`: REVISTORIA, EVENTOS, MARKETING, COBRANCA, ADMIN).
- `AdminTokenGuard` — header `x-admin-token` = `ADMIN_PANEL_TOKEN` (integrações sem JWT).
- `M7WebhookGuard` — header `x-m7-signature` = `M7_WEBHOOK_TOKEN`.

### Domínios

`sga` (Hinova: associados, veículos, boletos), `beneficios` (Alloyal — clube de vantagens), `postos`/`economia`/`fuel-session` (Clubgas — combustível e economia acumulada), `reinspection` (revistoria com fotos e pagamentos), `documentos`, `oficina`, `slider`, `notifications` (Expo Push + histórico persistido + popup), `admin-panel`, `analytics`, `app-version` (gate de versão mínima via semver).

`analytics` tem regras próprias: allowlists de telas/ações/formulários (`constants/`), scanner de chaves proibidas, hash HMAC/SHA-256 de identificadores e rate limit em Redis — respeitar essas barreiras ao adicionar eventos.

### Configuração

`src/config/env.validator.ts` roda antes do `NestFactory.create`: `REQUIRED` derruba o boot; `WARN_IF_MISSING` só emite warning. Toda env nova de integração deve ser classificada em uma das duas listas. Referência de valores em `.env.example`.

## Convenções

- Domínio, comentários e logs em **português**; código em TypeScript com nomes de domínio em português (`rastreamento`, `associado`, `boleto`).
- Logging via `Logger` do Nest com `private readonly logger = new Logger(X.name)`; usar `baseTag(baseOrigin)` no prefixo quando houver contexto de base.
- Pastas de DTO são sempre `dto/` (minúsculo) em todos os módulos.
- Imports internos entre pastas/módulos usam o formato absoluto `src/...` (o Nest CLI reescreve para relativo no build).
- `prisma/schema.prisma`: modelos antigos em minúsculo (`user`, `workshop`), novos em PascalCase. Migrations ficam versionadas em `prisma/migrations/`.
- Uploads gravam em `uploads/<subdir>/` (`FileUploadService`, com `sharp` para imagens) e são expostos como `/uploads/...`.
- `noImplicitAny` está desligado e várias regras `no-unsafe-*` do ESLint estão off — não assumir tipagem estrita.
- Documentação detalhada por feature em `docs/` (notificações, analytics, histórico de trajetórias, app-version gate, arquitetura).
