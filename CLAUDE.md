# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

```bash
npm run start:dev          # dev com watch (porta 3001 por padrão)
npm run build              # nest build -> dist/
npm run start:prod         # node dist/main
npm run lint               # eslint --fix em {src,apps,libs,test}/**/*.ts
npm run format             # prettier

npm test                   # jest (rootDir: src, testRegex: *.spec.ts) — não precisa de banco nem Redis
npm run test:watch
npm run test:cov
npm run test:e2e           # jest --config ./test/jest-e2e.json (*.e2e-spec.ts)
npm run test:integration   # test/integracao/*.integration-spec.ts — MariaDB e Redis reais (TEST_DATABASE_URL, TEST_REDIS_URL)
npm run typecheck
npm run verify             # typecheck + testes + build
npm run lint:arquitetura   # regras de dependência (eslint.arquitetura.mjs) — tem de passar

# um único arquivo / um único caso
npx jest src/analytics/analytics.service.spec.ts
npx jest -t "nome do teste"

# Prisma (não há scripts npm — usar o CLI direto)
npx prisma generate
npx prisma migrate dev --name descricao_da_mudanca
npx prisma studio

docker compose up -d --build api   # deploy padrão: redis + um container `api` que faz tudo (APP_ROLE=all)
docker compose up -d redis         # só o Redis (127.0.0.1:6379), para rodar a API com `npm run start:dev`
```

Swagger em `/docs` (em produção só com `SWAGGER_ENABLED=true`). Fora do prefixo global `/api`: `/health`, `/health/live`, `/health/ready` e `/metrics`.

Como testar (camadas, integração, o que não simular): `docs/TESTES.md`. Operação, deploy e variáveis: `docs/OPERACAO_E_DEPLOY.md`.

## Arquitetura

NestJS 11 (monolito modular com portas e adaptadores) + Prisma/MySQL + Redis/BullMQ. Documento vigente: `docs/ARQUITETURA_2026-11.md` (camadas, tenant, filas, erros, régua de PR).

`src/main.ts` define: `TZ=America/Sao_Paulo`, validação de env antes do boot, logger JSON (`LoggerEstruturado`), `requisicaoMiddleware` (requestId, contexto de log, linha de acesso, métricas HTTP), `trust proxy`, prefixo global `/api`, `ValidationPipe({ whitelist: true, transform: true })`, `AllExceptionsFilter` (filtro global único), corpo JSON de 1mb — 20mb só nas rotas de `rotasCorpoGrande` em `src/config/app.config.ts` (fotos em base64) —, `/uploads` servido estaticamente e `enableShutdownHooks()`.

### Papéis de processo

A mesma imagem roda como `APP_ROLE=api` (HTTP, só produz jobs), `worker` (consome as filas e roda os agendadores), `pdf` (só a fila de renderização de PDF, com o Chromium) ou `all` (tudo junto; padrão). O deploy padrão é `all` num container só (`docker-compose.yml`, `docker compose up -d --build api`); a separação em processos (api ×2, worker, pdf) é opcional e fica em `docker-compose.escala.yml` + `ops/deploy.sh`. O código tem de funcionar nos dois modos. `src/config/app.config.ts` é a fonte: `appConfig()`, `papelAtivo('worker')`. Processors entram nos módulos com `...paraPapel('worker', [XProcessor])` (`src/queue/queue.module.ts`); agendador e reconciliação de boot começam com `if (!papelAtivo('worker')) return;`. Nada que precise valer entre processos pode ficar em `Map` do processo (use `VendorSessionStore`, `CacheService`, `LimitadorService`, `TravaService`).

### Multi-tenant por `baseOrigin` — conceito central

Toda a API atende as bases do deploy (`TENANT_BASES`; padrão `MAIS_PRIME` e `MAIS_PRIME_RS`). A base vem no **JWT** (`payload.baseOrigin`, gravada em `AuthService.login`) e determina qual credencial de cada API externa será usada.

- A base é resolvida **uma vez, na borda**, e depois anda **por parâmetro**: `JwtStrategy` valida a claim (`isTenantBase`; desconhecida → 401; token antigo sem a claim lê `user.baseOrigin`); nas rotas use `@BaseOrigin()` (401 se o token não tiver base) ou `@BaseOrigin({ opcional: true })` para rota que também atende o painel; nos jobs, `baseDoJob(job.data)`.
- **Sem base não há operação**: `exigirBase(valor, 'contexto')` (`src/shared/tenant/tenant-context.ts`) lança `BaseNaoResolvidaError` (422). `TENANT.defaultBase` **não** é fallback (o lint de arquitetura proíbe fora de `src/config`). Não existe mais `BaseContextService` nem provider em escopo REQUEST.
- `src/shared/tenant/tenant-credentials.registry.ts` — `TenantCredentialsRegistry`: credenciais tipadas por integração (`registry.hinova(base)`, `.m7(base)`, `.logica(base)`, `.softruck(base)`, `.clubgas(base)`, `.alloyal(base)`) via `src/config/tenant.config.ts`. É o único lugar que conhece nome de env de credencial; ausente → `IntegrationError` 503 `INTEGRACAO_NAO_CONFIGURADA`. Ao adicionar integração nova, preencha a entrada em **todas** as bases. `TokenResolverService` é a API antiga e delega ao registry.
- `src/integrations/hinova/` — `SgaAuthService` (`executeRequestWithAuth`: sessão `token_usuario`, bloqueio e pausa de login compartilhados no Redis, login sob trava entre processos, rotação dos tokens de base, timeout padrão, disjuntor por base, dedupe em voo, reautenticação em 401) e `HinovaClient` (leituras repetidas pelo app com cache: associado, boletos e produtos do veículo; quem altera o dado no SGA chama `invalidar*`). Provido pelo `HinovaModule` (não global): todo módulo que fala com o SGA declara `imports: [HinovaModule]`.
- `maskSecret` / `baseTag` vivem em `src/shared/log.util.ts`; nunca logar valores de token (o logger também mascara CPF, token e senha).

`SharedModule` é `@Global()`, importado explicitamente no `AppModule`, e contém **só o que é agnóstico de vendor** (tenancy e utils). Autenticação/URL de vendor fica em `src/integrations/<vendor>`.

### Estrutura padrão por módulo

Cada módulo de domínio segue a mesma organização de pastas: `controllers/`, `services/` (aplicação: um caso de uso por operação), `domain/` (regra pura), `dto/` e, quando aplicável, `repositories/`, `guards/`, `processors/`, `strategies/`, `interfaces/`, `enums/`, `decorators/`. O `*.module.ts` fica na raiz do módulo. O `AppModule` contém **apenas imports de módulos** — nunca declarar controllers/providers de feature nele.

`domain/` não importa Nest, Prisma (só tipos), axios nem `src/infra`/`src/database`/`src/integrations`/`src/queue`; relógio e aleatoriedade entram por parâmetro. Controller e processor só montam o contexto e delegam. Service antigo usado por outros módulos vira **fachada fina** — nenhuma linha nova entra nela.

Transversais: `src/config/` (única leitura de `process.env`: `app.config`, `tenant.config`, `redis.config`, `integracoes.config`, `retencao.config`), `src/database/` (PrismaService — instância única global), `src/infra/` (auth/, guards/, observability/, filters/, rate-limit/, redis/, cache/, idempotencia/, outbox/, manutencao/, pdf/, health/, mail/, storage/ com `FileUploadService`), `src/integrations/` (um módulo por vendor externo, **não global**, exportando seu client ou porta: `clubgas/`, `hinova/`, `expo/` (porta `PushGateway`), `alloyal/`; `core/` tem `VendorSessionStore` e `Disjuntor`), `src/shared/` (tenancy, erros tipados, semáforo e utils agnósticos de vendor), `src/queue/` (nomes e política das filas, `ProdutorDeFilas`, `ProcessadorBase`, fila de mortos).

Regra de dependência: `controller → service → { domain | repository | client | fila } → { prisma | axios | redis }`; domínio consome domínio **só por módulo exportado**; guard transversal mora em `infra/guards`; URL/auth de vendor mora em `integrations/<vendor>` (axios só lá); `process.env` novo só em `config/`; nenhuma linha nova dentro de fachada de god service. Verificado por `npm run lint:arquitetura` (as exceções do legado ficam em `eslint.arquitetura.legado.mjs` e só diminuem). Detalhes e régua de PR em `docs/ARQUITETURA_2026-11.md`.

### Erros

`src/shared/erros/erros.ts`: `DomainError` (regra de negócio; 409/422 com `code`; na fila, sem retry), `IntegrationError` (vendor; 502/503/504; retry se transitória), `InfraError` (banco/Redis/fila; 503; retry). O `AllExceptionsFilter` preserva o corpo das `HttpException` e acrescenta `requestId`. `catch` que só loga e segue é proibido: ou trata de verdade, ou deixa propagar.

### Módulos globais

`DatabaseModule` (PrismaService), `InfraModule` (MailService, FileUploadService, PosseContaService, health e `/metrics`), `SharedModule` (TenantCredentialsRegistry, TokenResolverService), `RedisModule` (`REDIS_CLIENTE`), `CacheModule` (CacheService, VendorSessionStore), `RateLimitModule` (LimitadorService + interceptor global), `QueueModule` (BullMQ, ProdutorDeFilas, FilaDeMortosService), `PdfModule` (porta `PdfRenderer`), `ConsistenciaModule` (OutboxService, IdempotenciaService, TravaService, expurgos). **Nunca redeclarar** esses providers em módulos de feature — isso cria instâncias/pools duplicados.

### Filas (BullMQ)

Nomes e política de retry por fila em `src/queue/filas.ts` (reexportados por `src/queue/queue.module.ts`): `WEBHOOK_QUEUE`, `NOTIFICATION_QUEUE`, `FUEL_ECONOMY_QUEUE`, `BOLETO_VERIFICACAO_QUEUE`, `ANALYTICS_QUEUE`, `BOLETO_NOTIFICACAO_QUEUE`, `BOLETO_REATIVACAO_RETRY_QUEUE`, `ASSOCIADO_SORTE_QUEUE`, `MARKETING_AGENDADA_QUEUE`, `PUSH_MASSA_QUEUE`, `PDF_QUEUE`, `OUTBOX_QUEUE`, `MANUTENCAO_QUEUE` e `FILA_DE_MORTOS`.

Padrão: o controller enfileira com `ProdutorDeFilas.enfileirar(fila, job, dados, { base, jobId })` (o payload sai com `baseOrigin` e `_meta`) e responde imediatamente; um processor que estende `ProcessadorBase` (`executar(job)`) faz o trabalho no papel `worker`. Ex.: `POST /rastreamento/webhook-m7` → `WebhookProcessor` → `RastreamentoService.processarWebhookM7`.

Regras: entrega duplicada é assumida (handler idempotente pela chave de negócio; `jobId` determinístico barra a duplicata na entrada); nenhuma fila depende de ordem; trabalho por entidade é varredura com `SKIP LOCKED` sobre o MySQL, não job repetível por entidade; banco e fila juntos → `OutboxService`; erro definitivo ou tentativas esgotadas → fila de mortos (operação em `/api/admin/filas`, perfil ADMIN). Mudança de estado é `updateMany` com a condição no `WHERE` e checagem de `count`; rotina única usa `TravaService`; escrita por toque do usuário aceita `Idempotency-Key` (`IdempotenciaService`).

### Rastreamento (`src/rastreamento`)

Três provedores externos: **M7**, **Lógica Soluções** e **Softruck**, cada um em **submódulo Nest próprio** (`m7/m7.module.ts`, `logica/logica.module.ts`, `softruck/softruck.module.ts`) com `exports` explícitos, importados pelo `RastreamentoModule` (que fica só com o orquestrador e o `WebhookProcessor`). `SoftruckModule` importa `M7Module` (reverse geocode) e `LogicaModule` (fallback de histórico via `HistoricoProviderResolverService`, em `softruck/services/`). Cada subpasta segue `controllers/ services/ dto/ helpers/ mappers/ pdf/`. Os clients ficam em `m7/services/rastreamento-m7.ts`, `logica/services/rastreamento.logica.ts` e `softruck/services/rastreamento-softruck.service.ts`; a orquestração fica em `services/rastreamento.service.ts`. `RastreamentoService.rastreamento()` consulta os provedores em paralelo com `Promise.allSettled` e escolhe a posição mais recente.

- `RastreamentoService` é fachada; os casos de uso ficam em `services/` (`consultar-posicao`, `comandos-veiculo`, `processar-webhook-m7`, `consultas-por-provedor`), a regra pura em `domain/` e as queries em `repositories/`.
- Novo provedor: criar submódulo próprio (modelo `m7.module.ts`), implementar a porta `ProvedorDeRastreamento` (`providers/rastreamento-provider.interface.ts`: `nome`, `estaConfigurado(base)`, `obterUltimaPosicao`), exportá-lo e incluí-lo no token `PROVEDORES_DE_RASTREAMENTO` em `rastreamento.module.ts`. O orquestrador só percorre a lista; `providers/provedores.contrato.spec.ts` roda o mesmo conjunto de testes contra todos.
- Cada provedor resolve a própria credencial (`TenantCredentialsRegistry`) e a própria sessão: M7 em `m7/services/m7-auth.service.ts` e Lógica em `logica/services/logica-auth.service.ts`, ambas no Redis (`VendorSessionStore`), com login sob trava.
- Posição: cache de 15 s por chassi; o veículo guarda o provedor que o atende (`UserVehicle.provedorRastreamento`) e só ele é consultado, com revalidação periódica.
- Âncora e alerta de ignição são **por veículo** (`UserVehicle.ancoraAtiva`/`notificacaoIgnicao`; `null` = segue o valor da conta), sob trava por chassi, com auditoria em `VeiculoComandoLog`.
- Webhook M7 é idempotente: `eventoHash` único, `jobId` `m7-<hash>`, evento mais antigo que o último processado é descartado, `processed = true` só depois de acionar o push.
- `RastreamentoM7` e `LogicaRastreamentoService` são injetados pelo Nest — não instanciar com `new`.
- Relatórios PDF de histórico/trajetos pedem o PDF pela porta `PdfRenderer` (`src/infra/pdf`): um Chromium reaproveitado com semáforo no papel `pdf`/`all`; no papel `api`, o pedido vai pela fila `pdf-render` e a rota continua devolvendo o PDF. Não usar `puppeteer.launch` fora de `src/infra/pdf`.
- Por decisão do dono do projeto, as rotas de rastreamento **não checam posse do veículo** (exigem só autenticação). Não acrescentar essa checagem.

### Autenticação e autorização

Guards transversais ficam em `src/infra/guards/` (`JwtAuthGuard`, `AdminRoleGuard`, `AdminPanelRoleGuard`, `AdminTokenGuard`, `SomenteAssociadoGuard`); guards de um único fluxo ficam no módulo dono (`auth/guards/local-auth`, `auth/guards/primeiro-login`, `rastreamento/guards/m7`, `analytics/guards/optional-jwt-auth`). Guards sem dependências não precisam ser declarados como providers.

`request.user` (ver `src/infra/auth/usuario-autenticado.ts`) é `{ userId, cpf, role, baseOrigin, adminRole }`. App e painel assinam com o mesmo segredo e o `sub` é numérico nos dois: `userId` só identifica um associado quando **não** há `adminRole`. Rota de conta usa `exigirDonoOuAdmin(req.user, id)`; rota que recebe CPF usa `PosseContaService`; rota só do app usa `SomenteAssociadoGuard`. Toda rota tem guard ou está na lista de rotas públicas de `src/infra/auth/rotas-publicas.seguranca.spec.ts` (o teste falha se surgir rota sem guard). O primeiro acesso é só com o CPF (regra da associação). Limite de requisições por política: `@LimiteDeTaxa('<política>')` (`src/infra/rate-limit`).

- `JwtAuthGuard` / `LocalAuthGuard` (Passport) — usuários do app.
- `PrimeiroLoginGuard` — bloqueia rotas enquanto `user.primeiroLogin === true` (exceto a troca de senha).
- `AdminRoleGuard` — exige `role === ADMIN` no JWT.
- `AdminPanelRoleGuard` + `@AdminPanelRoles(...)` — painel administrativo (`AdminPanelRole`: REVISTORIA, EVENTOS, MARKETING, COBRANCA, ADMIN).
- `AdminTokenGuard` — header `x-admin-token` = `ADMIN_PANEL_TOKEN` (integrações sem JWT; protege também `POST /auth/register` e `POST /rastreamento/renovar-token`).
- `SomenteAssociadoGuard` — recusa token do painel em rota exclusiva do app (depois do `JwtAuthGuard`).
- `M7WebhookGuard` — header `x-m7-signature` = `M7_WEBHOOK_TOKEN`.

### Domínios

`sga` (Hinova: associados, veículos, boletos), `beneficios` (Alloyal — clube de vantagens), `direct-partners` (parceiros diretos do clube — CRUD no painel MARKETING, publicação por base, cupons de uso único com resgate em transação; docs em `docs/PARCEIROS_DIRETOS.md`), `postos`/`cartao`/`economia`/`fuel-session` (Clubgas — combustível e economia acumulada; toda falha sai do `ClubgasClient` como `ClubgasErro` já classificado (`src/integrations/clubgas/clubgas.erro.ts`) e o service chama `ClubgasErroLogService.tratar`, que grava em `ClubgasErroLog` (usuário, documento, placa, categoria, status e resposta do Clubgas) e devolve `{ statusCode, code: CLUBGAS_<CATEGORIA>, message }` — 422 com a mensagem do próprio Clubgas nas recusas, 502/503/504 com mensagem genérica nas falhas de infraestrutura), `reinspection` (revistoria com fotos e pagamentos; envio à Hinova em `ReinspectionHinovaService` com log em `ReinspectionHinovaEnvio` e reenvio manual via `POST /reinspection/:id/hinova/reenviar` — docs em `docs/REVISTORIA_HINOVA_ENVIO.md`; boleto de reativação em `BoletoReativacaoService` (`src/sga`, fachada de `GerarBoletoReativacaoService`): tentativa sob lease (`boletoLeaseAte`), retry por varredura de 60 s sobre `PENDENTE_RETRY`, adoção de boleto criado à mão no SGA (pela marca `REV-<id>` ou pelos critérios antigos), geração manual via `POST /reinspection/:id/boleto/gerar`, verificação de pagamento por varredura (`ReinspectionPayment.proximaConsultaEm`, `SKIP LOCKED`) e avisos de boleto pago pelo outbox (`boleto.pago`) — docs em `docs/REVISTORIA_BOLETO_REATIVACAO.md`; rotas do app são contrato e não mudam; `Reinspection.status` só é gravado por `ReinspectionRepository.transicionar`, segundo a tabela de `src/reinspection/domain/revistoria-transicoes.ts` (transição fora dela → 409 `REVISTORIA_TRANSICAO_INVALIDA`; `FINALIZADA` é terminal) — não gravar `status` por outro caminho nem abrir aresta nova sem decisão do dono do projeto; as rotas do app checam posse do veículo (`exigirDonoOuAdmin`); `ReinspectionService` é fachada dos casos de uso em `services/reinspection-*.service.ts`; regra por empresa (quem faz revistoria, template por tipo do SGA e códigos do boleto de reativação — conta, tipo, situação após boleto/pagamento) em `src/config/revistoria-regra.config.ts` — `REGRA_PADRAO` (Mais Prime/RS: `INADIMPLENTE 20 DIAS`, conta 27, veículo → 20 após o boleto) não se altera, outras empresas entram em `REGRAS_POR_BASE` (ex.: `HERTZ`: `INADIMPLENTE`, tipos exatos, conta 2, não altera a situação após o boleto, e `encargosPorAtraso` — multa de 2% uma vez + mora de 0,5% ao dia sobre o valor base, contados do vencimento do último boleto em aberto; cálculo em `src/sga/domain/boleto-encargos.ts`, memória em `ReinspectionPayment.encargos`; o cancelamento do boleto em aberto está pendente de rota da Hinova — `SgaBoletoClient.cancelarBoleto`) — docs em `docs/REVISTORIA_REGRAS_POR_EMPRESA.md`; exposta em `GET /reinspection/regra` (app), `GET /reinspection/regras` (painel), `template_revistoria` em `/sga/veiculos-info/:chassi` e `revistoria_obrigatoria` em `/sga/veiculos`), `documentos`, `oficina`, `slider`, `notifications` (push pela porta `PushGateway` + histórico persistido + popup; `NotificationsService` é fachada; push unitário na `NOTIFICATION_QUEUE` (alertas — nunca atrás de massa) e disparo em massa por `PushDisparo`/`PushEntrega` em lotes de 100 na `PUSH_MASSA_QUEUE`, com varredura de retomada e consulta em `GET /notifications/admin/disparos/:id`; disparo de marketing imediato ou agendado — `agendarPara` opcional em `POST /notifications/admin/marketing`, job atrasado na `MARKETING_AGENDADA_QUEUE`, fonte da verdade em `MarketingNotificationAuditLog` (`SCHEDULED → SENDING → SENT|FAILED`, ou `CANCELED`), reconciliado no boot por `MarketingAgendamentoService`; todo disparo e toda inclusão/alteração de pop-up grava quem fez e quando (`MarketingNotificationAuditLog`, `NotificationPopupAuditLog`) — docs em `docs/NOTIFICACOES_AGENDAMENTO_E_LOG.md`), `admin-panel`, `analytics`, `app-version` (gate de versão mínima via semver), `expo-updates` (servidor OTA self-hosted — Expo Updates Protocol; releases em `updates/<runtimeVersion>/<release>/`, publicação via `scripts/publicar-update.mjs`, docs em `docs/EXPO_UPDATES_OTA.md`), `associado-sorte` (Associado da Sorte v2 — só a base em `SORTE_BASES_CONTEMPLADAS` (`MAIS_PRIME`), para associados inscritos no produto do SGA (código `3677` + descrição "ASSOCIADO DA SORTE" ATIVO num veículo com acesso; cache em `SorteInscricao`, marcação MANUAL no painel prevalece; consulta via `HinovaModule` + `BeneficiosVeiculoModule` exportado): raspadinha com limite diário/intervalo no dia de Brasília que revela vouchers de um cronograma de momentos premiados (`SorteCampanha`/`SorteMomentoPremiado`, importado de CSV pelo helper `helpers/sorte-cronograma.helper.ts`, travado com SHA-256 ao publicar — depois disso 409 `CAMPANHA_TRAVADA`), Loja da Sorte (compra com créditos, pedido `SorteGanhador` origem `LOJA`, notificações do painel + e-mail pelo job `sorte-email-retirada`), lembrete programático por push e registro de tentativas; painel MARKETING em `/api/admin/associado-sorte`, app em `/api/associado-sorte`; toda escrita de saldo/estoque passa por `repositories/sorte-transacao.ts` com `SELECT ... FOR UPDATE` (raspar: carteira → momento com `SKIP LOCKED`; loja: prêmio → carteira; piloto: rodada → prêmio → carteira) e por `SorteCreditosService.lancar`; rodadas do piloto ficam atrás de `SorteConfig.rodadasHabilitadas`; job de 5 s na `ASSOCIADO_SORTE_QUEUE`, desligado por padrão (só com `ASSOCIADO_SORTE_AGENDADOR=true`); dados de demonstração com `npm run sorte:seed-demo` e aceite com `node --env-file=.env scripts/sorte-aceite.mjs` — contrato completo em `docs/ASSOCIADO_DA_SORTE.md`).

`boleto-notificacao` (régua de cobrança por push): `BoletoNotificacaoService` é fachada de `ExecutarReguaService`; uma execução por base e dia (`TravaService`), log `ENFILEIRADO`/`FALHA` de transporte sem ticket é reenviável, o job falha (e repete) quando uma base falha — docs em `docs/BOLETO_NOTIFICACAO_ROTINA.md`. `fuel-session`: uma sessão pendente por usuário (`FuelSession.pendenteChave` único) e checagens encadeadas na `FUEL_ECONOMY_QUEUE` (o job não falha por desenho). `beneficios` (Alloyal): client em `src/integrations/alloyal` (porta `AlloyalGateway`), services por assunto e o contrato de erro das rotas em `helpers/alloyal-erro-de-contrato.ts`.

`analytics` tem regras próprias: allowlists de telas/ações/formulários (`constants/`), scanner de chaves proibidas, hash HMAC/SHA-256 de identificadores e rate limit em Redis — respeitar essas barreiras ao adicionar eventos.

### Configuração

`src/config/env.validator.ts` roda antes do `NestFactory.create`: `REQUIRED` derruba o boot; `WARN_IF_MISSING` só emite warning. Toda env nova deve ser lida em `src/config/`, classificada em uma das listas (ou documentada no bloco de opcionais) e descrita no `.env.example`. `process.env` fora de `src/config` é barrado pelo lint de arquitetura.

## Convenções

- Domínio, comentários e logs em **português**; código em TypeScript com nomes de domínio em português (`rastreamento`, `associado`, `boleto`).
- Logging via `Logger` do Nest com `private readonly logger = new Logger(X.name)`; usar `baseTag(baseOrigin)` no prefixo quando houver contexto de base. Em produção a saída é JSON com `requestId`, `base`, `userId`, `queue` e `jobId` carimbados pelo contexto de execução (não é preciso repeti-los na mensagem).
- Métricas: usar os objetos de `src/infra/observability/metricas.ts` (os nomes são contrato com `ops/alertas/regras.yml`); rótulo só com valor de conjunto fechado, nunca id, CPF, chassi ou URL.
- Pastas de DTO são sempre `dto/` (minúsculo) em todos os módulos.
- Imports internos entre pastas/módulos usam o formato absoluto `src/...` (o Nest CLI reescreve para relativo no build).
- `prisma/schema.prisma`: modelos antigos em minúsculo (`user`, `workshop`), novos em PascalCase. Migrations ficam versionadas em `prisma/migrations/`.
- Uploads gravam em `uploads/<subdir>/` (`FileUploadService`, com `sharp` para imagens) e são expostos como `/uploads/...`.
- `noImplicitAny` está desligado e várias regras `no-unsafe-*` do ESLint estão off — não assumir tipagem estrita.
- Documentação detalhada por feature em `docs/` (notificações, analytics, histórico de trajetórias, app-version gate). Arquitetura vigente, regras de dependência e régua de PR: `docs/ARQUITETURA_2026-11.md` (`docs/ARQUITETURA_ALVO_2026-09.md` é o histórico da decisão original).
- Testes: regra pura em `domain/` sem mock; trava, lease, unique e fila contra banco e Redis reais em `test/integracao/`; rota com guard real em `*.seguranca.spec.ts` (apoio em `src/infra/auth/testing/jwt-de-teste.ts`). Ver `docs/TESTES.md`.
