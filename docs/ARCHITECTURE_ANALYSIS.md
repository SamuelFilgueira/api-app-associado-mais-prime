# Análise Arquitetural — beneficios-api

> Documento gerado após análise estática completa do código-fonte.  
> Data de referência: Mai/2026

---

## Sumário

1. [Etapa 1 — Análise da Arquitetura Atual](#etapa-1--análise-da-arquitetura-atual)
2. [Etapa 2 — Identificação dos Módulos Extraíveis](#etapa-2--identificação-dos-módulos-extraíveis)
3. [Etapa 3 — Arquitetura Recomendada](#etapa-3--arquitetura-recomendada)
4. [Etapa 4 — Extração do Módulo Reinspection / Admin-Panel](#etapa-4--extração-do-módulo-reinspection--admin-panel)
5. [Etapa 5 — Estrutura de Pastas Recomendada](#etapa-5--estrutura-de-pastas-recomendada)
6. [Etapa 6 — Roadmap de Migração](#etapa-6--roadmap-de-migração)
7. [Etapa 7 — Recomendação Final](#etapa-7--recomendação-final)

---

## Etapa 1 — Análise da Arquitetura Atual

### 1.1 Stack Real do Projeto

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 |
| Framework | NestJS 11 |
| ORM | Prisma 6 |
| Banco de dados | **MySQL** (não PostgreSQL — datasource provider: `mysql`) |
| Fila | BullMQ 5 + Redis 7 |
| Auth | Passport JWT + Passport Local |
| Push Notifications | Expo Server SDK |
| Email | Nodemailer + Gmail |
| PDF | Puppeteer + Chromium |
| Upload | Multer + sharp (sistema de arquivos local) |
| Containerização | Docker multi-stage + docker-compose |
| Documentação API | Swagger / OpenAPI |

---

### 1.2 Diagrama Textual da Arquitetura Atual

```
┌───────────────────────────────────────────────────────────────────┐
│                         React Native App                          │
└────────────────────────────┬──────────────────────────────────────┘
                             │ HTTPS / REST
                             ▼
┌───────────────────────────────────────────────────────────────────┐
│                        beneficios-api                             │
│                    (NestJS Monolith :3001)                         │
│                                                                   │
│  ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌─────────────────┐  │
│  │  Auth    │  │Associado│  │Rastreamento│  │  Notifications  │  │
│  │  Module  │  │ Module  │  │   Module  │  │    Module       │  │
│  └──────────┘  └─────────┘  └───────────┘  └─────────────────┘  │
│                                                                   │
│  ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌─────────────────┐  │
│  │Reinspect.│  │ Oficina │  │ Documentos│  │   Beneficios    │  │
│  │  Module  │  │ Module  │  │   Module  │  │  (Alloyal API)  │  │
│  └──────────┘  └─────────┘  └───────────┘  └─────────────────┘  │
│                                                                   │
│  ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌─────────────────┐  │
│  │ Admin    │  │  Slider │  │FuelSession│  │   SGA / Boleto  │  │
│  │  Panel   │  │ Module  │  │   Module  │  │  (sem módulo!)  │  │
│  └──────────┘  └─────────┘  └───────────┘  └─────────────────┘  │
│                                                                   │
│  ══════════ Camada Global ══════════════════════════════════════  │
│  ┌────────────────────┐  ┌────────────────────────────────────┐  │
│  │   SharedModule     │  │         QueueModule (Global)       │  │
│  │ BaseContextService │  │  BullMQ — 4 filas:                │  │
│  │ TokenResolverSvc   │  │  webhook-events                    │  │
│  │ SgaAuthService     │  │  notifications                     │  │
│  │ ExternalApiConfig  │  │  fuel-economy                      │  │
│  └────────────────────┘  │  boleto-verificacao                │  │
│                           └────────────────────────────────────┘  │
│                                                                   │
│  ══════════ Infraestrutura Compartilhada ═══════════════════════  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  PrismaService (instanciado em CADA módulo individualmente)  │ │
│  │  MailService (common/services — redeclarado no AppModule)    │ │
│  │  FileUploadService (common/services — redeclarado)           │ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────┬───────────────────────────────────────────────────┘
                │
     ┌──────────┼──────────────────────┐
     ▼          ▼                      ▼
┌─────────┐ ┌────────┐      ┌──────────────────────┐
│  MySQL  │ │ Redis  │      │  Integrações Externas│
│  (VPS)  │ │  :6379 │      │  ├─ SGA/Hinova       │
└─────────┘ └────────┘      │  ├─ Softruck         │
                            │  ├─ M7               │
                            │  ├─ Alloyal          │
                            │  ├─ Logica           │
                            │  ├─ ClubGas          │
                            │  └─ Expo Push        │
                            └──────────────────────┘
```

---

### 1.3 Mapa de Módulos e Responsabilidades

| Módulo | Localização | Responsabilidade principal |
|---|---|---|
| `AppModule` | `src/app.module.ts` | Root module — agrega tudo. Também registra diretamente Postos, Cartao, Economia, SGA (sem sub-módulos) |
| `AuthModule` | `src/auth/` | Autenticação de usuários (app mobile) via CPF/senha, JWT, reset de senha |
| `AdminPanelModule` | `src/admin-panel/` | Auth e CRUD de usuários do painel administrativo (roles: REVISTORIA, EVENTOS, MARKETING, COBRANCA) |
| `ReinspectionModule` | `src/reinspection/` | Fluxo completo de revistoria: criação, upload de fotos, envio para Hinova, aprovação/reprovação, boletos |
| `RastreamentoModule` | `src/rastreamento/` | Rastreamento veicular via Softruck e M7, histórico, PDF, webhook processor |
| `NotificationsModule` | `src/notifications/` | Push notifications Expo, marketing massivo, histórico de notificações |
| `AssociadoModule` | `src/associado/` | Perfil do associado, veículos, foto de perfil, sincronização SGA |
| `OficinaModule` | `src/oficina/` | CRUD de oficinas parceiras com upload de fotos |
| `DocumentosModule` | `src/documentos/` | Gestão de documentos com controle de visibilidade |
| `SliderModule` | `src/slider/` | Banners do app (slider) com upload de imagem |
| `FuelSessionModule` | `src/fuel-session/` | Sessões de abastecimento, cálculo de economia, processor assíncrono |
| `AlloyalApiModule` | `src/beneficios/` | Integração com API de benefícios Alloyal |
| `QueueModule` | `src/queue/` | Módulo global BullMQ + Redis — declara 4 filas |
| `SharedModule` | `src/shared/` | Módulo global com serviços de resolução de tokens multi-tenant |
| `SGA/Boleto` | `src/sga/` | Integração Hinova SGA, boletos, verificação async — **NÃO é módulo NestJS próprio** |
| `Postos/Cartao/Economia` | `src/postos|cartao|economia/` | Controllers/Services registrados diretamente no AppModule |

---

### 1.4 Fluxo de Autenticação

```
╔══ Fluxo Usuário (Mobile) ══════════════════════════════════════╗
║                                                                  ║
║  POST /api/auth/login                                            ║
║    └─> LocalStrategy.validate(cpf, password)                    ║
║          └─> AuthService.validateUser()                          ║
║                └─> bcrypt.compare(password, user.passwordHash)   ║
║    └─> AuthService.login()                                        ║
║          └─> JWT.sign({ sub, cpf, role, baseOrigin })            ║
║                └─> access_token (expira em 300d)                 ║
║                                                                  ║
║  Requests autenticados:                                          ║
║    Authorization: Bearer <token>                                 ║
║    └─> JwtAuthGuard → JwtStrategy.validate(payload)              ║
║          └─> req.user = { userId, email, username, role,         ║
║                           baseOrigin }                           ║
╚══════════════════════════════════════════════════════════════════╝

╔══ Fluxo Admin Panel ═══════════════════════════════════════════╗
║                                                                  ║
║  POST /api/admin-panel/auth/login                                ║
║    └─> AdminPanelUsersService.login()                            ║
║          └─> bcrypt.compare(password, adminUser.password)        ║
║    └─> JWT.sign({ sub, email, username, role: 'ADMIN' })         ║
║          └─> MESMA JWT_SECRET do usuário comum!                  ║
║          └─> access_token (expira em 1d)                         ║
║                                                                  ║
║  Requests admin autenticados:                                    ║
║    Authorization: Bearer <token>                                 ║
║    └─> JwtAuthGuard (reusa o guard de usuário)                   ║
║    └─> AdminPanelRoleGuard (guard adicional)                     ║
║          └─> Verifica req.user.role === 'ADMIN'                  ║
║          └─> QUERY NO BANCO: busca AdminPanelUser por email      ║
║          └─> Verifica se role está nos allowed roles             ║
╚══════════════════════════════════════════════════════════════════╝
```

---

### 1.5 Fluxo de Multi-Tenancy (BaseOrigin)

```
JWT payload contém: { baseOrigin: 'MAIS_PRIME' | 'MAIS_PRIME_RS' }
                          │
                          ▼
              BaseContextService.getBaseOrigin()
              (scoped per request — injetado via REQUEST)
                          │
                          ▼
              TokenResolverService.resolve*(baseOrigin)
              (lê variáveis de ambiente específicas)
                          │
                          ▼
      Todas as chamadas externas (SGA, Softruck, M7, Alloyal...)
      usam credenciais corretas para o tenant do usuário
```

---

### 1.6 Fluxo de Filas (BullMQ)

```
WEBHOOK_QUEUE (webhook-events)
  Producer: RastreamentoController (webhook recebido)
  Consumer: WebhookProcessor
  Ação: processa evento de rastreamento, notifica usuário

NOTIFICATION_QUEUE (notifications)
  Producer: NotificationsService
  Consumer: NotificationProcessor
  Ação: envia push notification via Expo SDK

FUEL_ECONOMY_QUEUE (fuel-economy)
  Producer: CartaoService (após transação de combustível)
  Consumer: FuelEconomyProcessor
  Delay: 5 minutos
  Ação: consulta API externa, calcula economia, notifica usuário

BOLETO_VERIFICACAO_QUEUE (boleto-verificacao)
  Producer: SgaService
  Consumer: BoletoVerificacaoProcessor
  Ação: polling de status de boleto na API Hinova
```

---

### 1.7 Dependências Entre Módulos (grafo)

```
AppModule
  ├── QueueModule (Global) ────────────────────────> Redis
  ├── SharedModule (Global) ───────────────────────> Env vars
  ├── AuthModule
  │     ├── PrismaService
  │     ├── JwtModule
  │     ├── MailService
  │     └── SharedModule (BaseContextService, TokenResolverService)
  │
  ├── AdminPanelModule
  │     ├── PrismaService
  │     └── JwtModule (MESMA secret!)
  │
  ├── ReinspectionModule ─────────────── ACOPLAMENTO CRÍTICO ──────┐
  │     ├── PrismaService                                           │
  │     ├── FileUploadService                                       │
  │     ├── MailService                                             │
  │     ├── AdminPanelRoleGuard ◄── importado de AdminPanelModule   │
  │     └── SgaService ◄─────────── importado de fora do módulo!   │
  │                                                                 │
  ├── RastreamentoModule                                            │
  │     ├── PrismaService                                           │
  │     ├── NotificationsModule                                     │
  │     ├── SharedModule                                            │
  │     └── WebhookProcessor → WEBHOOK_QUEUE                       │
  │                                                                 │
  ├── NotificationsModule                                           │
  │     ├── PrismaService                                           │
  │     ├── AdminPanelRoleGuard ◄── importado de AdminPanelModule ──┘
  │     └── Expo SDK
  │
  ├── OficinaModule
  │     ├── PrismaService
  │     ├── FileUploadService
  │     └── AdminPanelRoleGuard ◄── importado de AdminPanelModule
  │
  ├── DocumentosModule
  │     ├── PrismaService
  │     ├── FileUploadService
  │     └── AdminPanelRoleGuard ◄── importado de AdminPanelModule
  │
  ├── SliderModule
  │     ├── PrismaService
  │     ├── FileUploadService
  │     └── AdminPanelRoleGuard ◄── importado de AdminPanelModule
  │
  ├── AssociadoModule
  │     ├── PrismaService
  │     ├── FileUploadService
  │     ├── AuthModule
  │     └── SharedModule
  │
  └── FuelSessionModule
        ├── PrismaService
        ├── EconomiaService ◄── importado de fora do módulo!
        └── NotificationsModule
```

---

### 1.8 Integrações Externas

| Integração | Módulo consumidor | Protocolo | Autenticação |
|---|---|---|---|
| SGA / Hinova | `SgaService`, `ReinspectionService` | REST/HTTPS | Bearer token (renovação automática em cache) |
| Softruck | `RastreamentoSoftruck` | REST/HTTPS | Bearer token por BaseOrigin |
| M7 | `HistoricoM7Service` | REST/HTTPS | Bearer token por BaseOrigin |
| Alloyal | `AlloyalApiService` | REST/HTTPS | API Secret por BaseOrigin |
| Logica | Múltiplos módulos via `BaseContextService` | REST/HTTPS | Bearer token por BaseOrigin |
| ClubGas | Módulos de combustível | REST/HTTPS | Bearer token por BaseOrigin |
| Expo Push | `NotificationsService` | REST/HTTPS | Server SDK |
| Gmail / Nodemailer | `MailService` | SMTP | App Password |

---

### 1.9 Problemas Arquiteturais Identificados

#### Problema 1 — Dois sistemas de auth com o mesmo JWT_SECRET

`AuthModule` e `AdminPanelModule` assinam JWTs com `process.env.JWT_SECRET` e expirations diferentes (300d vs 1d). O `JwtStrategy` é compartilhado. Um token de usuário comum poderia, em teoria, ser usado em rotas admin se o `AdminPanelRoleGuard` tiver falha. O guard faz um lookup extra no banco para mitigar isso, mas a raiz do problema é arquitetural.

#### Problema 2 — AdminPanelRoleGuard com query N+1 implícita

```typescript
// admin-panel-role.guard.ts
const adminPanelUser = await this.prisma.adminPanelUser.findUnique({
  where: { email: userEmail },
});
```

Toda request admin autentica **duas queries de banco**: uma para verificar o usuário e outra para buscar o `AdminPanelUser`. Além disso, esse guard está instanciado como provider em 5 módulos diferentes (Reinspection, Notifications, Oficina, Documentos, Slider), criando dependência transitiva de `AdminPanelModule` em metade do sistema.

#### Problema 3 — SgaService injetado diretamente em ReinspectionModule

```typescript
// reinspection.module.ts
providers: [
  SgaService, // ← Service de outro "contexto" declarado aqui
```

`SgaService` não é exportado por um `SgaModule` — é declarado diretamente no `AppModule` como provider não-modular e reimportado manualmente no `ReinspectionModule`. Isso viola o encapsulamento e torna impossível extrair `ReinspectionModule` sem arrastar `SgaService` junto.

#### Problema 4 — PrismaService não é global

`PrismaService` é reinstanciado em cada módulo. Com NestJS DI, isso cria múltiplas instâncias do Prisma Client, o que pode resultar em pool de conexões fragmentado. O correto seria marcar `PrismaService` como `@Global()` ou exportá-lo de um `DatabaseModule` global.

#### Problema 5 — Controllers sem módulo próprio no AppModule

`PostosController`, `CartaoController`, `EconomiaController`, `SgaController`, `BoletoController`, `BeneficiosVeiculoController` estão registrados diretamente no `AppModule` sem módulo encapsulador. Isso mistura responsabilidades no módulo raiz e impede isolamento futuro.

#### Problema 6 — MailService redeclarado em providers do AppModule e ReinspectionModule

`MailService` aparece como provider tanto no `AppModule` quanto no `ReinspectionModule`. Duas instâncias separadas do transporter Nodemailer.

#### Problema 7 — EconomiaService injetado no FuelSessionModule sem exportação formal

```typescript
// fuel-session.module.ts
providers: [
  EconomiaService, // ← Classe de outro contexto importada diretamente
```

Acoplamento direto por importação de classe sem passagem por módulo encapsulador.

#### Problema 8 — Uploads em sistema de arquivos local

Todos os uploads (perfil, oficina, revistoria, slider, documentos) são salvos no filesystem da VPS. Sem S3/CDN, a escala é limitada e o deploy de um segundo container quebraria (volume não compartilhado).

#### Problema 9 — Ausência de versionamento de API

Não existe prefixo de versão (`/api/v1/`). Qualquer breaking change impacta todos os clientes simultaneamente.

#### Problema 10 — Validação de variáveis de ambiente incompleta

`env.validator.ts` valida apenas 9 variáveis de um total de ~30+ usadas no sistema. Uma variável ausente descoberta em runtime causa erro silencioso ou exception não tratada.

---

## Etapa 2 — Identificação dos Módulos Extraíveis

### 2.1 Tabela de Análise

| Módulo | Responsabilidade | Nível de Acoplamento | Complexidade de Extração | Recomendação |
|---|---|---|---|---|
| `reinspection` | Fluxo de revistoria + pagamentos admin | **ALTO** — usa AdminPanelRoleGuard, SgaService, MailService, FileUpload | **ALTA** — precisa desacoplar guard e SgaService primeiro | Extrair APÓS desacoplamento dos guards e SGA |
| `admin-panel` | Auth e gestão de usuários administrativos | **MÉDIO** — exporta guard para 5 módulos | **MÉDIA** — guard é um ponto de acoplamento invertido | Extrair junto com reinspection |
| `rastreamento` | GPS tracking, histórico, PDFs, webhooks | **MÉDIO** — usa NotificationsModule, SharedModule | **MÉDIA** — depende de fila Redis compartilhada | Candidato futuro (fase 2) |
| `notifications` | Push Expo, marketing | **BAIXO** — apenas PrismaService + Expo SDK | **BAIXA** — módulo relativamente isolado | Manter no monólito por agora |
| `oficina` | CRUD de oficinas, fotos | **BAIXO** — usa AdminPanelRoleGuard | **BAIXA** após fix do guard | Manter no monólito |
| `documentos` | Gestão de documentos | **BAIXO** — usa AdminPanelRoleGuard | **BAIXA** após fix do guard | Manter no monólito |
| `slider` | Banners do app | **BAIXO** — usa AdminPanelRoleGuard | **BAIXA** | Manter no monólito |
| `associado` | Perfil do associado | **MÉDIO** — usa AuthModule + SharedModule | **MÉDIA** | Manter no monólito |
| `sga/boleto` | Integração Hinova, boletos | **ALTO** — sem módulo encapsulador | **MUITO ALTA** — transformar em módulo primeiro | Modularizar, não extrair ainda |
| `beneficios` (Alloyal) | Benefícios, pontos | **BAIXO** — isolado | **BAIXA** | Manter no monólito |
| `fuel-session` | Economia de combustível | **MÉDIO** — depende de EconomiaService | **MÉDIA** | Manter no monólito |

### 2.2 Dependências Críticas para Extração de Reinspection + Admin-Panel

Antes de extrair, é obrigatório resolver:

1. **`AdminPanelRoleGuard`** — precisa funcionar como validação de token JWT por si só, sem query ao banco no monólito principal.
2. **`SgaService` no `ReinspectionModule`** — a integração Hinova precisa ser chamada via HTTP interno (do serviço de reinspection → API principal) ou o SgaService precisa ser duplicado.
3. **`MailService`** — o serviço de reinspection precisa de acesso a e-mail. Pode ser mantido localmente no novo serviço.
4. **`FileUploadService`** — uploads de fotos de revistoria precisam de um destino compartilhado (volume Docker ou storage externo).
5. **`PrismaService`** — banco compartilhado inicialmente, apontando para o mesmo MySQL.

---

## Etapa 3 — Arquitetura Recomendada

### 3.1 Padrão Recomendado: Modular Monolith com Extração Cirúrgica

**Não recomendo microservices completos.** Para o tamanho atual do sistema, time pequeno e mesma VPS, a melhor estratégia é:

```
Fase 0: Consolidar o monólito (remover acoplamentos ruins)
Fase 1: Modular Monolith (fronteiras claras, sem distribuição)
Fase 2: Strangler Fig para extrair reinspection/admin-panel
Fase 3: Avaliar necessidade real de mais extrações
```

O padrão **Strangler Fig** é ideal: você cria o novo serviço ao lado, redireciona rotas gradualmente via Nginx, e depreca as rotas do monólito sem reescrever tudo de uma vez.

### 3.2 Organização de Responsabilidades

```
beneficios-api (Monólito Principal)
├── Domínio: Usuários / Autenticação
├── Domínio: Veículos / Rastreamento  
├── Domínio: Benefícios (Alloyal, ClubGas)
├── Domínio: Oficinas / Postos
├── Domínio: Economia / Combustível
├── Domínio: Notificações (Push)
└── Domínio: SGA / Boletos (integração Hinova)

ops-service (Novo Serviço — fase 2)
├── Domínio: Revistoria (Reinspection)
└── Domínio: Painel Administrativo
```

### 3.3 Como Evitar Dependências Cruzadas

**Regra principal:** módulos não devem importar classes de outros módulos diretamente. Devem importar o **módulo** e usar apenas o que foi **exportado**.

```typescript
// ERRADO — importação direta de classe de outro contexto
import { SgaService } from 'src/sga/sga.service';

// CORRETO — importação via módulo encapsulador
@Module({ imports: [SgaModule] })
// e SgaModule exporta SgaService
```

**Guards transversais** (como `AdminPanelRoleGuard`) devem residir em um módulo de infraestrutura compartilhado, não no módulo de negócio que os originou.

### 3.4 Autenticação Entre Serviços (Service-to-Service)

Para a comunicação entre o `ops-service` e o `beneficios-api`:

```
Opção A — Shared Secret (simples, recomendado inicialmente)
  ops-service → beneficios-api
  Header: X-Internal-Token: <SECRET_INTERNO>
  beneficios-api valida o header via guard interno

Opção B — JWT com audience separado (mais seguro)
  ops-service gera JWT com audience='internal'
  beneficios-api valida audience + secret
  Permite auditar calls entre serviços

NÃO recomendo mTLS na VPS por enquanto — complexidade desnecessária.
```

### 3.5 Versionamento de APIs

Adotar prefixo de versão imediatamente:

```typescript
// main.ts
app.setGlobalPrefix('api/v1');

// Para o novo serviço
app.setGlobalPrefix('ops/v1');
```

No Nginx, proxy por prefixo:
```nginx
location /api/v1/    { proxy_pass http://beneficios-api:3001; }
location /ops/v1/    { proxy_pass http://ops-service:3002;   }
```

### 3.6 Logs e Observabilidade

Recomendo adotar **structured logging** (JSON) imediatamente, sem dependências pesadas:

```typescript
// logger.interceptor.ts — NestJS LoggingInterceptor customizado
// Logar: method, path, statusCode, duration, userId, requestId
// Formato JSON para facilitar parse por ferramentas (Loki, Datadog, etc.)
```

Para a fase inicial na mesma VPS: **logs em arquivo** rotacionados com `logrotate`. Sem necessidade de stack de observabilidade agora.

---

## Etapa 4 — Extração do Módulo Reinspection / Admin-Panel

### 4.1 Estratégia de Comunicação Recomendada

**REST HTTP interno (JSON)** — não gRPC, não eventos, não fila para operações síncronas.

```
Justificativa:
- Mesma VPS → latência negligível (< 1ms local)
- REST é familiar ao time atual
- Fácil debug (curl, Postman, logs)
- Zero overhead de protocolo binário
- Fácil evolução para separar fisicamente no futuro

gRPC: overkill para este tamanho. Adiciona complexidade de proto files,
       geração de código, e pouca vantagem em volume baixo.

Fila (MQ) para chamadas síncronas: anti-pattern. Introduz latência
       e complexidade sem benefício aqui.
```

### 4.2 Pré-requisitos Antes da Extração

```
Pré-requisito 1: Criar SgaModule formal
  src/sga/sga.module.ts
  @Module({ providers: [SgaService, ...], exports: [SgaService] })

Pré-requisito 2: Mover AdminPanelRoleGuard para um módulo de infra
  src/infra/guards/admin-panel-role.guard.ts
  Exportado por InfraModule (global)
  
Pré-requisito 3: Tornar PrismaService global
  @Global() @Module({ providers: [PrismaService], exports: [PrismaService] })
  src/database/database.module.ts

Pré-requisito 4: Unificar MailService em um único provider global

Pré-requisito 5: Ajustar FileUploadService para path configurável via ENV
```

### 4.3 Banco de Dados Compartilhado — Análise

**Inicialmente: banco compartilhado é a escolha correta.** Aqui está o raciocínio:

| Aspecto | Banco compartilhado | Banco separado |
|---|---|---|
| Joins entre tabelas | Funciona nativamente | Requer API calls ou duplicação de dados |
| Transações distribuídas | Não necessárias | Muito complexo (2PC, sagas) |
| Schema evolution | Uma migração | Migrations coordenadas |
| Operacional | Simples | Dois servidores MySQL |
| Custo | Sem overhead | Mais memória/disco |

**Riscos do banco compartilhado:**
- Acoplamento de schema: mudança de tabela no monólito pode quebrar o ops-service
- Sem isolamento de carga: queries pesadas de um serviço impactam o outro
- Governança: qual serviço "possui" qual tabela não é explícito

**Mitigação dos riscos:**
- Definir claramente: `reinspection-*` e `AdminPanelUser` são propriedade do `ops-service`
- O monólito só acessa essas tabelas via API do ops-service (não diretamente)
- Criar views ou APIs para dados que o monólito precisar de consultar

### 4.4 Autenticação Entre os Serviços

```
Fluxo atual:
  App Mobile → POST /api/admin-panel/auth/login → beneficios-api

Fluxo futuro:
  App Mobile → POST /ops/v1/auth/login → ops-service
    └─> ops-service valida credenciais no próprio banco (AdminPanelUser)
    └─> ops-service retorna JWT assinado com OPS_JWT_SECRET

  App Mobile → GET /ops/v1/reinspection → ops-service
    └─> ops-service valida JWT internamente (OPS_JWT_SECRET)
    └─> ops-service chama beneficios-api se necessário
          Header: X-Internal-Token: <INTERNAL_SECRET>
```

**Importante:** usar `JWT_SECRET` **diferente** para o ops-service. Tokens do monólito não devem ser aceitos pelo ops-service e vice-versa.

### 4.5 Estratégia de Deploy com Docker

```yaml
# docker-compose.prod.yml (visão futura)
services:
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    volumes: ["./nginx.conf:/etc/nginx/nginx.conf"]
    depends_on: [api, ops-service]

  api:                          # beneficios-api
    build: ./beneficios-api
    expose: ["3001"]
    environment:
      PORT: 3001
      REDIS_HOST: redis
      INTERNAL_SERVICE_SECRET: ${INTERNAL_SECRET}

  ops-service:                  # reinspection + admin-panel
    build: ./ops-service
    expose: ["3002"]
    environment:
      PORT: 3002
      DATABASE_URL: ${DATABASE_URL}   # mesmo banco inicialmente
      JWT_SECRET: ${OPS_JWT_SECRET}   # secret diferente!
      MAIN_API_URL: http://api:3001
      INTERNAL_SERVICE_SECRET: ${INTERNAL_SECRET}

  redis:
    image: redis:7-alpine
    expose: ["6379"]

  mysql:
    image: mysql:8
    expose: ["3306"]
    volumes: ["mysql-data:/var/lib/mysql"]
```

### 4.6 Configuração Nginx

```nginx
# /etc/nginx/nginx.conf
upstream main_api {
    server api:3001;
    keepalive 32;
}

upstream ops_service {
    server ops-service:3002;
    keepalive 16;
}

server {
    listen 443 ssl;
    server_name api.seudominio.com.br;

    # Rotas do painel administrativo → ops-service
    location ~ ^/ops/v1/ {
        proxy_pass http://ops_service;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
    }

    # Legacy: redirecionar rotas antigas durante migração
    location ~ ^/api/v1/admin-panel/ {
        proxy_pass http://ops_service;
        # Manter por 1 release cycle, depois remover
    }

    # API principal → beneficios-api
    location /api/v1/ {
        proxy_pass http://main_api;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
        client_max_body_size 25M;  # para uploads base64
        proxy_read_timeout 120s;
    }

    # Uploads estáticos
    location /uploads/ {
        proxy_pass http://main_api;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
```

### 4.7 Como Evitar Breaking Changes

**Estratégia Strangler Fig com proxy de compatibilidade:**

```
Fase A — Adicionar novas rotas no ops-service:
  POST /ops/v1/reinspection
  GET  /ops/v1/reinspection
  POST /ops/v1/admin-panel/auth/login
  
Fase B — Manter rotas antigas no monólito como proxy:
  // No monólito: ReinspectionController → encaminha para ops-service
  @Post('/reinspection')
  async createProxy(@Body() dto, @Req() req) {
    return this.httpClient.post(`${OPS_URL}/ops/v1/reinspection`, dto, {
      headers: { Authorization: req.headers.authorization }
    });
  }

Fase C — Após 1 sprint de validação em produção:
  Comunicar time mobile para migrar para /ops/v1/
  Manter proxy por 2 semanas para rollback seguro

Fase D — Remover proxy e deprecar rotas antigas
```

### 4.8 Variáveis de Ambiente

```bash
# beneficios-api/.env
PORT=3001
DATABASE_URL=mysql://user:pass@mysql:3306/beneficios
REDIS_HOST=redis
REDIS_PORT=6379
JWT_SECRET=<secret_usuarios_app>
INTERNAL_SERVICE_SECRET=<secret_comunicacao_interna>
OPS_SERVICE_URL=http://ops-service:3002

# ops-service/.env  
PORT=3002
DATABASE_URL=mysql://user:pass@mysql:3306/beneficios  # mesmo banco inicialmente
JWT_SECRET=<secret_ops_diferente_do_principal>         # OBRIGATÓRIO ser diferente
INTERNAL_SERVICE_SECRET=<mesmo_secret_interno>
MAIN_API_URL=http://api:3001
GMAIL_USER=...
SENHA_APP=...
```

---

## Etapa 5 — Estrutura de Pastas Recomendada

### 5.1 Backend Principal (refatorado)

```
beneficios-api/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   │
│   ├── database/                        # ← NOVO: módulo global Prisma
│   │   ├── database.module.ts           # @Global() exports PrismaService
│   │   └── prisma.service.ts
│   │
│   ├── infra/                           # ← NOVO: infraestrutura transversal
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   ├── admin-role.guard.ts
│   │   │   └── internal-service.guard.ts  # ← guard para X-Internal-Token
│   │   ├── interceptors/
│   │   │   └── logging.interceptor.ts
│   │   ├── pipes/
│   │   └── infra.module.ts             # @Global() exports guards
│   │
│   ├── shared/                          # serviços multi-tenant (mantido)
│   │   ├── base-context.service.ts
│   │   ├── token-resolver.service.ts
│   │   ├── sga-auth.service.ts
│   │   ├── external-api-config.service.ts
│   │   └── shared.module.ts
│   │
│   ├── common/
│   │   └── services/
│   │       ├── mail.service.ts          # provider único, exportado por InfraModule
│   │       └── file-upload.service.ts
│   │
│   ├── config/
│   │   └── env.validator.ts             # validar TODAS as envs
│   │
│   ├── queue/
│   │   └── queue.module.ts              # (mantido)
│   │
│   ├── auth/                            # domínio autenticação usuário
│   ├── associado/                       # domínio associado
│   ├── rastreamento/                    # domínio rastreamento
│   ├── notifications/                   # domínio notificações
│   ├── sga/                             # ← transformar em SgaModule com exports
│   │   ├── sga.module.ts               # @Module exports: [SgaService]
│   │   ├── sga.service.ts
│   │   └── boleto/
│   ├── beneficios/                      # domínio Alloyal
│   ├── oficina/                         # domínio oficinas
│   ├── documentos/                      # domínio documentos
│   ├── slider/                          # domínio slider
│   ├── postos/                          # ← criar PostosModule
│   ├── cartao/                          # ← criar CartaoModule
│   ├── economia/                        # ← criar EconomiaModule
│   └── fuel-session/
│
├── contracts/                           # ← NOVO: contratos compartilhados
│   ├── reinspection.types.ts           # DTOs/tipos usados entre serviços
│   └── internal-api.types.ts
│
├── prisma/
│   └── schema.prisma
├── docker-compose.yml
└── Dockerfile
```

### 5.2 Novo Serviço — ops-service

```
ops-service/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   │
│   ├── database/
│   │   ├── database.module.ts           # @Global() PrismaService
│   │   └── prisma.service.ts
│   │
│   ├── infra/
│   │   ├── guards/
│   │   │   ├── ops-jwt.guard.ts         # JWT separado (OPS_JWT_SECRET)
│   │   │   └── ops-role.guard.ts        # guard de roles admin
│   │   ├── interceptors/
│   │   │   └── logging.interceptor.ts
│   │   └── infra.module.ts
│   │
│   ├── common/
│   │   └── services/
│   │       ├── mail.service.ts          # cópia do mail service
│   │       └── file-upload.service.ts  # cópia do file upload
│   │
│   ├── config/
│   │   └── env.validator.ts
│   │
│   ├── auth/                            # auth SEPARADO para admin panel
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts           # POST /ops/v1/auth/login
│   │   └── auth.service.ts
│   │
│   ├── admin-panel/                     # gestão de usuários admin
│   │   ├── admin-panel.module.ts
│   │   ├── users.controller.ts
│   │   └── users.service.ts
│   │
│   ├── reinspection/                    # domínio revistoria
│   │   ├── reinspection.module.ts
│   │   ├── reinspection.controller.ts
│   │   ├── reinspection.service.ts
│   │   ├── payments/
│   │   │   ├── payments.controller.ts
│   │   │   └── payments.service.ts
│   │   └── dto/
│   │
│   └── clients/                         # ← NOVO: HTTP clients para serviços externos
│       ├── main-api.client.ts           # client HTTP para beneficios-api
│       └── hinova-sga.client.ts         # client direto para Hinova (se necessário)
│
├── prisma/
│   └── schema.prisma                    # cópia ou subset do schema principal
│
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

### 5.3 Libs Compartilhadas (opcional — fase 2+)

Se o volume de código compartilhado crescer, considerar um workspace monorepo:

```
workspace/
├── packages/
│   ├── contracts/                       # tipos/DTOs compartilhados (TypeScript)
│   │   ├── src/
│   │   │   ├── reinspection.dto.ts
│   │   │   ├── user.dto.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── prisma-client/                   # Prisma Client gerado (opcional)
│       └── package.json
│
├── apps/
│   ├── beneficios-api/
│   └── ops-service/
│
└── package.json (workspace root)
```

> **Nota pragmática:** só adote monorepo se o overhead de sincronizar tipos entre repositórios se tornar um problema real. Para dois serviços, duplicar os DTOs é aceitável inicialmente.

---

## Etapa 6 — Roadmap de Migração

### Fase 0 — Consolidação do Monólito (Semanas 1–2)

**Objetivo:** Eliminar os acoplamentos que impedirão a extração futura. Sem criar nenhum novo serviço ainda.

| Tarefa | Risco | Esforço |
|---|---|---|
| Criar `DatabaseModule` global com `PrismaService` | Baixo | 2h |
| Criar `SgaModule` formal com exports corretos | Baixo | 3h |
| Mover `AdminPanelRoleGuard` para `InfraModule` global | Baixo | 2h |
| Unificar `MailService` — remover declaração duplicada no AppModule | Baixo | 1h |
| Criar `PostosModule`, `CartaoModule`, `EconomiaModule` (encapsular) | Baixo | 4h |
| Corrigir injeção de `EconomiaService` no `FuelSessionModule` | Baixo | 1h |
| Adicionar prefixo `/api/v1/` nas rotas | **MÉDIO** — breaking change mobile | 3h |
| Expandir `env.validator.ts` para cobrir todas as envs | Baixo | 2h |

**Prioridade:** Alta. Sem essa fase, qualquer extração posterior será frágil.

**Rollback:** Qualquer mudança é reversível com git revert.

---

### Fase 1 — Preparação do ops-service (Semanas 3–4)

**Objetivo:** Criar o novo serviço NestJS com autenticação própria, rodando em paralelo, **sem remover nada do monólito ainda**.

| Tarefa | Risco | Esforço |
|---|---|---|
| Inicializar projeto NestJS `ops-service` | Baixo | 4h |
| Copiar schema Prisma (ou criar subset) | Baixo | 2h |
| Implementar auth admin separado (POST /ops/v1/auth/login) | Baixo | 4h |
| Implementar CRUD `AdminPanelUser` | Baixo | 3h |
| Configurar Docker + docker-compose para rodar junto | Baixo | 3h |
| Configurar Nginx para rotear `/ops/v1/` | Baixo | 2h |
| Definir `INTERNAL_SERVICE_SECRET` | Baixo | 1h |

**Critério de saída:** ops-service rodando em staging, admin panel frontend consegue logar pelo novo endpoint.

---

### Fase 2 — Migração do Reinspection (Semanas 5–7)

**Objetivo:** Mover o domínio de revistoria para o ops-service com proxy de compatibilidade no monólito.

| Tarefa | Risco | Esforço |
|---|---|---|
| Migrar `ReinspectionService` e controllers para ops-service | Médio | 12h |
| Implementar `HinovaSgaClient` no ops-service | Médio | 6h |
| Implementar `MailService` local no ops-service | Baixo | 2h |
| Implementar `FileUploadService` com mesmo volume Docker | Baixo | 3h |
| Adicionar proxy de compatibilidade no monólito | Baixo | 4h |
| Testes de integração end-to-end | Médio | 8h |
| Deploy em staging + validação com frontend | Médio | 4h |

**Critério de saída:** App mobile funcionando 100% via novas rotas `/ops/v1/reinspection`.

---

### Fase 3 — Cutover e Limpeza (Semana 8–9)

**Objetivo:** Remover código duplicado do monólito e formalizar a separação.

| Tarefa | Risco | Esforço |
|---|---|---|
| Remover `ReinspectionModule` do monólito | Baixo (já migrado) | 2h |
| Remover `AdminPanelModule` do monólito | Baixo (já migrado) | 2h |
| Remover proxy de compatibilidade (após 2 semanas) | Baixo | 1h |
| Atualizar documentação de rotas | Baixo | 2h |
| Atualizar Swagger em ambos os serviços | Baixo | 3h |

---

### Fase 4 — Observabilidade Básica (Semanas 10–11)

**Objetivo:** Garantir visibilidade mínima antes de crescer mais.

| Tarefa | Risco | Esforço |
|---|---|---|
| Adicionar `LoggingInterceptor` estruturado em ambos os serviços | Baixo | 4h |
| Configurar `logrotate` para arquivos de log | Baixo | 2h |
| Adicionar health-check endpoints (`GET /health`) | Baixo | 2h |
| Configurar alertas básicos de disponibilidade (UptimeRobot) | Baixo | 1h |

---

### Fase 5 — Evolução Futura (Trimestre 2+)

**Avaliar apenas se houver necessidade real:**

| Item | Gatilho para fazer |
|---|---|
| Extrair `RastreamentoModule` | Volume de webhooks causar lentidão no monólito |
| Migrar uploads para S3/Object Storage | Deploy em múltiplos containers necessário |
| Banco de dados separado para ops-service | Queries do ops causarem locks no banco principal |
| Monorepo (Nx ou Turborepo) | Três ou mais serviços com código compartilhado |
| Service mesh / mTLS | Múltiplos serviços em redes diferentes |
| gRPC para comunicação interna | Latência REST interno > 50ms (improvável na mesma VPS) |

---

## Etapa 7 — Recomendação Final

### O que realmente recomendar

**Arquitetura: Modular Monolith + extração cirúrgica de ops-service**

Não defenda microservices ainda. O sistema tem ~14 módulos, um banco, uma VPS, e um time pequeno. A complexidade operacional de microservices plenos (service discovery, circuit breakers, distributed tracing, sagas) não é justificável agora e provavelmente nunca será, a menos que você tenha problemas específicos de escala que só microservices resolvem.

A extração de `reinspection` + `admin-panel` faz sentido por razões de negócio, não de escala:
- Permite deploy independente do painel admin sem afetar o app mobile
- Isola a responsabilidade operacional de revistoria
- Permite que o painel admin evolua com tecnologia diferente no futuro (ex: BFF GraphQL)

### O que evitar

| Armadilha | Por que evitar |
|---|---|
| **Big Bang rewrite** | Paralisa desenvolvimento de features, alto risco de regressão |
| **Microservices para tudo** | Distributed monolith é pior que monolith bem estruturado |
| **gRPC internamente na fase inicial** | Overhead de geração de código e curva de aprendizado sem benefício real |
| **Event-driven para operações síncronas** | Adiciona latência e complexidade para debugar |
| **Banco separado antes de isolar código** | Transações distribuídas são muito caras de implementar corretamente |
| **Kubernetes na fase inicial** | Docker Compose + VPS é suficiente para anos de operação |
| **Criar uma lib shared antes de ter 3+ serviços** | YAGNI — você vai criar abstrações erradas cedo demais |
| **Mudar para TypeORM ou outro ORM** | Prisma funciona bem, mudança não agrega valor |

### Erros comuns nessa jornada

1. **Extrair sem desacoplar primeiro** — você move o código mas as dependências continuam, criando um distributed monolith impossível de manter.

2. **Usar mensageria assíncrona onde REST serve** — filas são para processamento assíncrono com tolerância a falha, não para chamadas request-response entre serviços.

3. **Compartilhar o ORM/Prisma Client entre serviços** — cada serviço deve ter seu próprio `prisma generate` com seu próprio schema. Compartilhar o client cria acoplamento de build.

4. **Tentar fazer shared library antes da hora** — abstrações prematuras são dívida técnica. Duplique o código por 1-2 sprints e depois extraia quando o padrão estiver claro.

5. **Não versionar APIs antes de extrair** — sem `/api/v1/`, qualquer mudança de rota é um breaking change. O versioning deve vir **antes** da extração.

6. **Fazer rollout do novo serviço sem proxy de compatibilidade** — sempre mantenha as rotas antigas funcionando por pelo menos 2 semanas após o cutover.

### Equilíbrio ideal para este projeto

```
SIMPLICIDADE:    ████████░░  80% — não adicionar complexidade sem necessidade real
ESCALABILIDADE:  ██████░░░░  60% — suficiente para crescimento de 5-10x sem reestruturar
PRODUTIVIDADE:   █████████░  90% — time pequeno precisa de feedback loop rápido
CUSTO:           ████████░░  80% — mesma VPS por mais 1-2 anos, sem overhead de infra
```

**Resumo executivo:** Faça a Fase 0 (limpeza) agora, independentemente de qualquer plano de extração. Um monólito bem estruturado é melhor que um monólito mal estruturado e infinitamente melhor que microservices mal feitos. A extração do ops-service é válida e factível em 8-9 semanas sem parar a produção, desde que as dependências sejam desacopladas primeiro.
