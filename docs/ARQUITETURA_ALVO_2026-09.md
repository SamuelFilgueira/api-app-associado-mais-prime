# Arquitetura do beneficios-api — Monólito Modular com Portas e Adaptadores simplificado (Set/2026)

Documento de decisão e referência. Diz **qual padrão** o projeto segue, **como ficou** a estrutura após a implementação de 2026-09-09, **quais são os pontos focais** da aplicação e **o que ainda não foi feito de propósito**. Serve de régua para PRs.

Validação da implementação: `npm run verify` verde (typecheck, 23 suítes / 219 testes, build), boot completo do `AppModule` com as 154 rotas mapeadas idênticas, ESLint limpo nos arquivos tocados. **Nenhuma lógica de negócio, rota, DTO ou resposta foi alterada.**

---

## 1. Decisão

**Padrão: Monólito Modular com Portas e Adaptadores simplificado por módulo** ("hexagonal leve").

Cada módulo NestJS é uma fronteira de domínio. Dentro dele o fluxo é sempre:

```
controller → service → { repository | client de integração | fila } → { Prisma | axios | Redis }
```

Tudo que fala com o mundo externo (banco, HTTP de terceiros, Redis, disco, e-mail, PDF) fica em um adaptador com nome e pasta próprios. Os god services continuam existindo e passam a ser **a camada de aplicação** do módulo; a regra é que **nenhum código novo entra neles**.

O que este padrão **não** é:

- Não é Clean Architecture completa (sem `domain/`, `use-cases/`, sem interface por service). Isso exigiria quebrar os god services, que hoje têm zero testes.
- Não é DDD tático (sem agregados, value objects, eventos de domínio). O domínio é majoritariamente orquestração de APIs de terceiros.
- Não é microserviços. Uma VPS, um MySQL, time pequeno, nenhum gargalo medido.

## 2. Por que este padrão

| Alternativa | Por que não agora |
|---|---|
| Clean Architecture completa | Custo estimado de 111–163 dev-dias, risco alto nos fluxos financeiros (Hinova) e zero ganho visível para o app. Fica como **padrão-alvo para código novo**; god services só são quebrados quando uma feature os toca e depois de caracterizados por testes. |
| DDD / CQRS / eventos | Pouca regra própria para modelar; a complexidade está na integração, não no domínio. |
| Microserviços | Sem necessidade de deploy independente ou escala horizontal comprovada. |
| Ficar como estava | Funcionava, mas a cada integração nova o time decidia de novo onde colocar client, config e token por tenant. Faltavam regras escritas e um ponto único por vendor. |

O que o padrão resolve **sem tocar em lógica**:

1. Onde nasce código novo (client, repository, config) é inequívoco.
2. Dependências externas têm um ponto de entrada por vendor, pré-requisito para testar os god services depois (mock por construtor, como já se faz em `boleto-notificacao.service.spec.ts`).
3. Multi-tenant (`baseOrigin`) é resolvido **dentro do adaptador**, como o `ClubgasClient` faz, e sai dos controllers.
4. As arestas entre domínios ficam visíveis nos `imports:` dos módulos, sem `@Global` escondendo dependência de vendor.

## 3. Estrutura

### 3.1 Transversais (globais) e integrações

```
src/
├── config/          tenant.config.ts · env.validator.ts        funções puras, sem módulo
├── database/        @Global  PrismaService (instância única)
├── infra/           @Global  mail/ storage/ guards/ decorators/ filters/ interceptors/ health/
│   └── guards/      admin-panel-role · admin-role · admin-token · jwt-auth   ← guards transversais
├── shared/          @Global  token-resolver · base-context (REQUEST) · date/html/log utils
│                             (só o que é AGNÓSTICO de vendor)
├── queue/           @Global  BullMQ + nomes das filas
└── integrations/    adaptadores por vendor. NÃO globais: cada um exporta seu client
    ├── clubgas/     ClubgasModule → ClubgasClient (postos, cartão, economia)
    └── hinova/      HinovaModule → SgaAuthService + SGA_BASE_URL (autenticação e URL da Hinova/SGA)
```

Regra para `shared/`: só o que é agnóstico de vendor. Autenticação Hinova saiu daqui para `integrations/hinova`.

### 3.2 Anatomia padrão de um módulo de domínio

```
src/<dominio>/
├── <dominio>.module.ts   imports de OUTROS domínios só via módulo exportado
├── controllers/          entrada HTTP: valida DTO, extrai @BaseOrigin(), delega. Sem regra de negócio.
├── dto/                  entrada (class-validator) e, quando houver, resposta
├── services/             camada de aplicação. É AQUI que os god services vivem, intactos.
├── repositories/         saída para o banco (Prisma). Modelo: app-version/repositories/app-version.repository.ts
├── mappers/              tradução payload-externo → formato do app. Modelo: rastreamento/logica/mappers/
├── config/               leitura tipada de env com defaults. Modelo: boleto-notificacao/config/boleto-notificacao.config.ts
├── processors/           consumidores BullMQ (WorkerHost); só delegam ao service
└── guards/ constants/ helpers/ enums/ interfaces/   quando aplicável
```

Módulos de referência já no padrão: `boleto-notificacao/` (config + client + services pequenos + processor), `app-version/` (repository), `postos|cartao|economia` (consomem `ClubgasClient`).

### 3.3 Rastreamento: um submódulo por provedor

```
src/rastreamento/
├── rastreamento.module.ts   imports: [NotificationsModule, M7Module, LogicaModule, SoftruckModule]
│                            providers: RastreamentoService (orquestrador), WebhookProcessor
├── m7/m7.module.ts          exports: RastreamentoM7, M7ReverseGeocodeService
├── logica/logica.module.ts  exports: LogicaRastreamentoService, TrajetosService, LogicaHistoricoService
└── softruck/softruck.module.ts   imports: [M7Module, LogicaModule]
                                  exports: RastreamentoSoftruck, HistoricoSoftruckService
```

Arestas internas agora explícitas: `softruck → m7` (reverse geocode) e `softruck → logica` (fallback de histórico via `HistoricoProviderResolverService`, que passou a viver em `softruck/services/` porque só é consumido lá).

### 3.4 Grafo de dependências entre domínios (todas via `imports:` de módulo)

```
reinspection → sga, hinova          associado → auth, hinova
sga, boleto, beneficios-veiculo → hinova
boleto-notificacao → hinova         rastreamento → notifications, m7, logica, softruck
fuel-session → economia, notifications      cartao → fuel-session, clubgas
postos, economia → clubgas
```

Zero `forwardRef`. Aresta nova só com `exports` explícito e sem ciclo.

## 4. Regras de dependência (régua de PR)

1. **Sentido único**: `controller → service → {repository | client | queue} → {prisma | axios | redis}`. Nunca o inverso; nunca controller → Prisma/axios.
2. **Domínio consome domínio só por módulo exportado** (`imports: [SgaModule]` + `exports: [SgaService]`). Proibido importar constante, guard ou service de `src/<outro-dominio>/...` sem passar pelo módulo. Se a coisa é transversal, ela muda de lugar: guard → `infra/guards`, URL/auth de vendor → `integrations/<vendor>`.
3. **Adaptador resolve o tenant**: quem recebe `baseOrigin` e decide a credencial é o client em `integrations/`, via `TokenResolverService`. Controller usa `@BaseOrigin()` e repassa; não monta contexto de tokens.
4. **`process.env` só em `config/`** (global ou do módulo). Env nova = entrada em `env.validator.ts` + leitura em um `*.config.ts` com default igual ao comportamento atual. As 81 leituras legadas espalhadas não foram migradas; a regra vale para código novo.
5. **REQUEST scope só em `BaseContextService`**. Service que precisa de tenant recebe `baseOrigin` por parâmetro (padrão `ClubgasClient`).
6. **Nenhuma linha nova dentro de god service.** Funcionalidade nova em módulo que tem god service nasce em um service novo ao lado (ex.: `reinspection-payments-admin.service.ts`).
7. **Um processor por fila, no módulo dono da fila**; processor não contém regra, chama o service.
8. **Filesystem, e-mail, PDF e SDK de terceiros são adaptadores** (`infra/` ou `integrations/`), nunca chamados direto de controller.

## 5. O que foi feito em 2026-09-09 (só movimentação e ligação; zero lógica)

| Mudança | Antes | Depois |
|---|---|---|
| Autenticação Hinova | `src/shared/sga-auth.service.ts`, exportado pelo `SharedModule` `@Global` | `src/integrations/hinova/sga-auth.service.ts`, provido/exportado por `HinovaModule` (não global) |
| URL da Hinova | `src/sga/constants/sga.constants.ts` (domínio `sga` era dono; `associado` e `boleto-notificacao` importavam de lá) | `src/integrations/hinova/hinova.constants.ts` (`SGA_BASE_URL`) |
| Consumidores da Hinova | dependiam do global | `SgaModule`, `BoletoModule`, `BeneficiosVeiculoModule`, `ReinspectionModule`, `AssociadoModule`, `BoletoNotificacaoModule` declaram `imports: [HinovaModule]` |
| `SharedModule` | tenancy + Hinova | só tenancy (`TokenResolverService`, `BaseContextService`) |
| Guards transversais | `auth/guards/{jwt-auth,admin-role}.guard.ts`, `notifications/guards/admin-token.guard.ts` (15 módulos dependiam de `auth/` e `expo-updates` de `notifications/` por arquivo solto) | `src/infra/guards/` (junto do `AdminPanelRoleGuard`); 27 imports reescritos |
| `AdminTokenGuard` | redeclarado como provider em `NotificationsModule` e `ExpoUpdatesModule` | sem provider (guard sem dependências, usado só em `@UseGuards`) |
| Rastreamento | 1 módulo com 19 providers | `RastreamentoModule` (orquestrador) + `M7Module` + `LogicaModule` + `SoftruckModule`, cada um com `exports` explícitos |
| `HistoricoProviderResolverService` | `rastreamento/services/` | `rastreamento/softruck/services/` (único consumidor); spec movida junto |

Ficaram em `auth/guards/`: `local-auth.guard.ts` e `primeiro-login.guard.ts` (específicos do fluxo de auth; o segundo é exportado pelo `AuthModule`). Ficaram no domínio: `analytics/guards/optional-jwt-auth.guard.ts` (zona quente) e `rastreamento/guards/m7.guard.ts` (só o webhook usa).

Exceção documentada: `boleto-notificacao/services/sga-boleto-periodo.client.ts` é um client HTTP da Hinova, mas depende da config e dos enums do próprio módulo. Permanece no domínio como *anticorruption layer* local. Se um segundo módulo precisar dele, ele sobe para `integrations/hinova/` junto com suas interfaces.

## 6. Pontos focais da aplicação

| Ponto | Onde | Por que importa |
|---|---|---|
| Tenancy | `src/config/tenant.config.ts` → `src/shared/token-resolver.service.ts` | Único lugar que mapeia `baseOrigin` → nome de env. Toda integração nova preenche as **duas** bases aqui. |
| Contexto de request | `src/shared/base-context.service.ts` (REQUEST) | Único REQUEST-scoped. Injetá-lo em service torna o service request-scoped (hoje só `AlloyalApiService`). |
| Hinova / SGA | `src/integrations/hinova/` | Auth com cache de `token_usuario` por base, dedupe em voo, reauth em 401. Três domínios chamam o SGA (`sga`, `associado`, `boleto-notificacao`); todos passam por aqui para token e URL. |
| ClubGas | `src/integrations/clubgas/clubgas.client.ts` | Modelo de client: resolve token por base internamente. |
| Guards | `src/infra/guards/` | `JwtAuthGuard` (app), `AdminRoleGuard` (`role === ADMIN`), `AdminPanelRoleGuard` + `@AdminPanelRoles`, `AdminTokenGuard` (`x-admin-token`). |
| Orquestração de rastreamento | `src/rastreamento/services/rastreamento.service.ts` | `Promise.allSettled` nos 3 provedores; regra de prioridade M7 (60 min). Provedores em submódulos próprios. |
| Fluxo financeiro | `src/sga/services/sga.service.ts` (`criarBoletoReativacao`) + `src/sga/processors/boleto-verificacao.processor.ts` | Cria boleto real na Hinova, altera situação de veículo, agenda polling. Sem testes; **não tocar sem caracterização (F3)**. |
| Revistoria | `src/reinspection/services/reinspection.service.ts` (1260 linhas) | Maior god service: Prisma + upload + mail + Hinova + boleto. Idem. |
| Filas | `src/queue/queue.module.ts` | 6 filas BullMQ; controller enfileira, `*.processor.ts` executa. |
| Config | `src/config/env.validator.ts` | `REQUIRED` derruba o boot; `WARN_IF_MISSING` só avisa. Toda env nova entra aqui. |
| Contrato HTTP | `*.contract.spec.ts` (auth, boleto, rastreamento, alloyal) + `app-version.controller.integration.spec.ts` | Congelam o shape de resposta. Qualquer refatoração futura precisa mantê-los verdes sem edição. |

God services (>500 linhas, sem teste, intocados): `reinspection.service` 1260, `alloyal-api.service` 1134, `historico-pdf-m7.service` 917, `rastreamento.service` 782, `rastreamento-softruck.service` 765, `boleto-notificacao.service` 712 (tem testes), `notifications.service` 691, `sga.service` 662, `rastreamento-m7` 610, `historico-m7.service` 587, `historico-pdf-softruck.service` 570.

## 7. O que fica para depois (exige testes antes)

Ordem já acordada no plano de manutenibilidade:

1. **F3** Testes de caracterização dos god services (mock por construtor) e contract specs nos 25 controllers restantes.
2. **F4** Clients `HinovaClient` (endpoints, unificando os 3 caminhos), `AlloyalClient`, `M7Client`, `LogicaClient`, `SoftruckClient` em `integrations/`; services passam a chamá-los.
3. **F5** `AlloyalApiService` sai do REQUEST scope; `buildRastreamentoContext` sai dos 7 controllers.
4. **F6** Quebra dos god services, um por PR, começando por `sga.service`.
5. **F7** Repositories onde houver query repetida (`user-vehicle`, `user-lookup`).

Trilha B (mudanças de comportamento) e pendências A1–A10 continuam fora: só entram com decisão explícita item a item.

## 8. Checklist de revisão de PR

- [ ] Arquivo novo está na pasta da anatomia padrão (3.2)?
- [ ] Nenhum `process.env` novo fora de `config/`?
- [ ] Nenhum import de `src/<outro-dominio>/...` que não passe pelo módulo?
- [ ] Chamada HTTP externa nova está em `integrations/<vendor>` e resolve tenant lá dentro?
- [ ] Controller só valida, extrai `@BaseOrigin()` e delega?
- [ ] Nenhuma linha nova dentro de um god service (lista na seção 6)?
- [ ] `npm run verify` verde e contract specs inalterados?

## 9. Histórico

- `docs/REFATORACAO_ESTRUTURAL_2026-07.md`: AppModule limpo, DI corrigida, pastas padronizadas, `ClubgasClient`.
- Plano de manutenibilidade F0–F2 (2026-08-31): scripts `verify`, contract specs, dedupe, configs por módulo, `AdminPanelRoleGuard` em `infra/`.
- Este documento (2026-09-09): `integrations/hinova`, guards transversais em `infra/`, submódulos de rastreamento, regras escritas.
- Análises anteriores (`docs/ARCHITECTURE_ANALYSIS.md`, `docs/MODULAR_MONOLITH_TARGET.md`) continuam válidas como contexto; este documento prevalece onde houver conflito.
