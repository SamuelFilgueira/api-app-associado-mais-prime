# Refatoração Estrutural — Julho/2026

Refatoração de **arquitetura e DI** com regra absoluta: **nenhuma lógica de negócio alterada** e **contrato HTTP do app intocado**. Validado com `npm run build` e `npm test` (18/18 suítes, 97/97 testes verdes).

Foi executada em duas etapas: (1) correção de módulos/DI e primeiro client de integração; (2) **reestruturação completa de pastas** — todo módulo passou a seguir o layout padrão `controllers/ services/ dto/ [guards/ processors/ strategies/ interfaces/ repositories/ enums/ decorators/]`, com ~120 arquivos movidos via `git mv` (histórico preservado) e 393 imports reescritos para o formato absoluto `src/...`.

## O que foi ajustado

### 1. AppModule limpo — todos os módulos importados corretamente
Antes, o `AppModule` declarava 6 controllers/providers "órfãos" diretamente. Agora ele contém **apenas imports de módulos** + `AppController`/`AppService`:

| Órfão | Destino |
|---|---|
| `PostosController/Service` | novo `PostosModule` (`src/postos/postos.module.ts`) |
| `CartaoController/Service` | novo `CartaoModule` (`src/cartao/cartao.module.ts`, importa `FuelSessionModule`) |
| `BoletoController/Service` | novo `BoletoModule` (`src/sga/boleto/boleto.module.ts`) |
| `BeneficiosVeiculoController/Service` | `BeneficiosVeiculoModule` (já existia órfão; agora importado) |
| `AlloyalApiController` | movido para o `AlloyalApiModule` |
| `BoletoVerificacaoProcessor` | movido para o `SgaModule` |

O `SharedModule` (`@Global`) agora é **importado explicitamente no AppModule** — antes entrava por carona via `RastreamentoModule` (se aquele import sumisse, a DI de metade da aplicação quebrava).

### 2. Fim das instâncias duplicadas (DI corrigida)
- `PrismaService` removido dos providers de `AnalyticsModule` e `ReinspectionModule` → **de 3 pools de conexão MySQL para 1** (o `DatabaseModule` global é a única fonte).
- `MailService` e `SgaService` removidos dos providers do `ReinspectionModule` (Mail vem do `InfraModule` global; `SgaService` via `imports: [SgaModule]`) → fim do segundo transporter SMTP/SES e da segunda instância SGA.
- `FileUploadService` promovido ao `InfraModule` (`@Global`) e removido dos providers de `associado`, `documentos`, `notifications`, `oficina`, `slider`.
- `AdminPanelRoleGuard` removido dos providers de 5 módulos (guards de `@UseGuards` não precisam ser providers) e sua injeção morta de `PrismaService` eliminada. Comportamento do guard **inalterado**.

### 3. Descontaminação do escopo REQUEST na árvore de auth
`AuthService` injetava `BaseContextService` (Scope.REQUEST) e `TokenResolverService` **sem usar nenhum dos dois**, forçando `AuthService`, `AuthController`, `LocalStrategy`, `AssociadoService` e `AssociadoController` a serem reinstanciados a cada request. As duas injeções mortas foram removidas → toda a árvore voltou a **singleton**.

### 4. Primeira camada de integração: `ClubgasClient`
Criado `src/integrations/clubgas/` (client + module) — o padrão para os demais vendors:
- Único ponto que conhece a URL da API ClubGas (antes hardcoded em 3 arquivos) e que resolve o token por base via `TokenResolverService`.
- **Fim do token drilling**: `PostosController` e `CartaoController` não injetam mais `BaseContextService`/`TokenResolverService` nem repassam token/tokenKey por parâmetro (a assinatura de 8 parâmetros posicionais de `buscarPostos` caiu para 6; `gerarCartaoVirtual` de 5 para 3). Controllers usam o decorator `@BaseOrigin()` já existente e viraram roteamento puro → deixaram de ser REQUEST-scoped.
- `EconomiaService` passou a usar o client. O método `obterTotalEconomizadoLegado` **preserva intencionalmente** o token fixo `TOKEN_API_CLUBGAS` (corrigir o multi-tenant ali é mudança de comportamento — pendência A8 abaixo).

### 5. Código morto removido
- `src/storage/` inteiro (`StorageService` + `LocalStorageProvider` — nunca usados; instanciavam com `new` em vez de DI).
- `src/shared/external-api-config.service.ts` (REQUEST-scoped, nunca injetado).
- `src/queue/index.ts` (barrel não usado e desatualizado).
- `src/rastreamento/m7/helpers/m7-trajetos-filter.helper.ts` (`filtrarTrajetos` sem nenhum chamador).
- Import morto de `Prisma` em `rastreamento.service.ts`.

### 6. Deduplicações mecânicas
- `maskSecret` reimplementado 5× (postos ×2, cartao ×2, softruck) → todos usam `src/shared/log.util.ts`.
- 7 specs stub que quebravam com erro de DI (montavam `TestingModule` sem as dependências) foram consertados com mocks mínimos → `npm test` agora é um sinal confiável (antes: 7 suítes falhando; agora: 0).

## Arquitetura final

```
src/
├── main.ts · app.module.ts          # AppModule: SÓ imports de módulos
├── config/                          # tenant.config.ts (multi-tenant) + env.validator.ts
├── database/                        # @Global → prisma.service.ts (movido da raiz; instância única)
├── infra/                           # @Global — transversal técnico
│   ├── mail/mail.service.ts         # (ex-common/services)
│   ├── storage/file-upload.service.ts
│   ├── decorators/base-origin.decorator.ts   # @BaseOrigin() — extrai tenant do request
│   ├── filters/ · interceptors/ · health/
├── integrations/
│   └── clubgas/                     # ClubgasClient — padrão de client por vendor
├── shared/                          # @Global — TokenResolver, BaseContext, SgaAuth, log utils
├── queue/                           # @Global — 5 filas BullMQ
└── <domínio>/                       # TODOS os módulos seguem o mesmo layout:
    ├── <dominio>.module.ts          #   módulo na raiz
    ├── controllers/                 #   *.controller.ts (+ specs)
    ├── services/                    #   *.service.ts (+ specs)
    ├── dto/                         #   sempre minúsculo (fim das pastas DTOs/)
    └── quando aplicável: guards/ processors/ strategies/ interfaces/
                          repositories/ enums/ decorators/ providers/ utils/ constants/
```

Domínios: `auth/` (controllers, services, guards, strategies, interfaces, dto) · `associado/` · `sga/` (controllers, services, processors, dto + submódulos `boleto/` e `beneficios-veiculo/` — o aninhamento duplicado `beneficios-veiculo/beneficios-veiculo/` foi achatado) · `rastreamento/` (controllers, services, processors, guards, providers + `m7/`, `logica/`, `softruck/`; os clients `rastreamento-m7.ts` e `rastreamento.logica.ts` saíram da raiz para `m7/services/` e `logica/services/`; `rastreamento-softruck.service.ts` foi para `softruck/services/`) · `postos/` · `cartao/` · `economia/` · `fuel-session/` (services, processors) · `oficina/` · `documentos/` · `slider/` · `notifications/` (controllers, services, guards, processors, dto) · `beneficios/` (Alloyal) · `reinspection/` · `admin-panel/` (controllers, services, guards, decorators, enums, dto) · `analytics/` (controllers, services, processors, providers, guards, utils, constants, dto) · `app-version/` (controllers, services, repositories, dto).

Convenções estabelecidas:
- Imports internos no formato absoluto `src/...` (o Nest CLI os reescreve para relativos no `dist` — verificado no compilado).
- Regra de dependência: `controller → service → { prisma, integrations, infra }`; domínio A só consome domínio B via `exports` do módulo (ex.: `ReinspectionModule → SgaModule`, `CartaoModule → FuelSessionModule`).
- `dto/` minúsculo em 100% dos módulos.

## O que NÃO mudou (de propósito)
- Nenhuma rota, DTO público, formato de resposta ou regra de negócio.
- Guards comentados, bypasses e comportamento do `AdminPanelRoleGuard` (qualquer ADMIN passa) — pendências de decisão, não de arquitetura.

## Próximos passos (plano completo em `.claude/plans/`, fases 2–6)
1. **Config centralizada**: `ConfigModule.forRoot` (o `@nestjs/config` está instalado e nunca foi usado); migrar os ~100 `process.env` restantes módulo a módulo.
2. **Testes de caracterização** (e2e + nock) dos god services **antes** de quebrá-los.
3. **Clients restantes** no padrão do `ClubgasClient`: `HinovaClient`, `AlloyalClient`, `M7Client` (unifica o token duplicado de `RastreamentoM7`/`HistoricoM7Service`), `LogicaClient` (elimina o `TrajetosService`, cópia).
4. **Quebra dos god services** (reinspection 1311 linhas, alloyal 1051, sga 786, rastreamento 784, notifications 733, analytics 705) — só depois dos testes.
5. **Rastreamento**: ativar o contrato `IRastreamentoProvider` (hoje dead code — Softruck não implementa), unificar os 3 serviços PDF (1804 linhas) num `PdfRenderer` com templates.
6. **Repositories seletivos** no modelo de `app-version.repository.ts`.

## Pendências de segurança/bugs (fora do escopo desta refatoração — exigem decisão)
- A1: rotas sem guard (`POST /rastreamento/renovar-token`, `GET ignicao-status`/`ancora-status`, `POST /notifications/test`).
- A2: guards comentados em `reinspection`, `documentos`, `oficina`.
- A3: `JWT_SECRET` único em 3 módulos com fallback `'minha_chave_secreta'` (token do app aceito em rotas admin).
- A4: `@AdminPanelRoles` decorativo (qualquer ADMIN passa em tudo).
- A5: regra `cortarRastreamento` contornável por 8 das 19 rotas de histórico/PDF.
- A6: bug de indexação em `notifications.service.ts:644` (chunks de push marketing).
- A7: `resetPassword` com `Math.random()`.
- A8: `EconomiaService` ignora multi-tenant (token ClubGas fixo) e faz UPDATE num GET.
- A9: endpoint de teste `POST /auth/test-ses-email` em produção.
- A10: comparação de token M7 não constant-time; CORS aberto; Swagger sem auth; sem `enableShutdownHooks`.
