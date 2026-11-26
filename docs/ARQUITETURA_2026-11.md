# Arquitetura do beneficios-api (novembro de 2026)

Documento vigente. Substitui `ARQUITETURA_ALVO_2026-09.md` como referência de padrão e de régua de PR;
aquele documento continua valendo como histórico da decisão original.

O padrão não mudou: **monólito modular com portas e adaptadores**. O que mudou foi a execução (três
papéis de processo), a camada `domain/` para regra pura, e a disciplina nas bordas: tenant,
integrações, filas e erros. O plano completo, com os achados que motivaram cada mudança, está no
documento "Plano de arquitetura e escala" (fora do repositório).

## 1. Decisões

| Decisão | Ganho | Custo aceito |
|---|---|---|
| Um código, um banco, três papéis de processo (`APP_ROLE=api`, `worker`, `pdf`), que por padrão rodam juntos (`all`) | O deploy segue sendo um container; quando a carga pedir, PDF e jobs saem do processo HTTP e a API sobe em duas réplicas, sem mudar código | Todo estado que vivia na memória do processo foi para o Redis ou para o MySQL; o código tem de funcionar nos dois modos |
| Quatro camadas por módulo | Regra testável sem Nest nem Prisma; god service vira casos de uso pequenos | Mais arquivos |
| Porta (classe abstrata como token de injeção) só onde há troca real: vendors, fila, push, PDF | Fakes nos testes e troca de provedor | Services internos continuam concretos; nada de interface por classe |
| Outbox onde gravar no banco e publicar na fila precisam acontecer juntos | "Commit feito, Redis fora" deixa de perder o efeito | Uma tabela e um job de despacho |
| Regras de dependência verificadas por ferramenta | A régua de PR deixa de depender de revisão manual | Lista de exceções do legado, que só diminui |

Alternativas descartadas (microserviços, Clean Architecture em todos os módulos, só escalar a máquina,
Kubernetes) e os motivos estão no plano.

## 2. Camadas dentro de um módulo

```
controllers/  processors/      só montam o contexto (usuário, base) e delegam
        │
        ▼
services/                      aplicação: um caso de uso por operação
        │
        ├──► domain/           regra pura: sem Nest, Prisma, HTTP ou fila
        │
        └──► repositories/     Prisma (onde a query se repete ou há trava)
             integrations/<vendor>   client do vendor
             ProdutorDeFilas   saída para as filas
```

- `domain/` não importa `@nestjs/*`, `@prisma/client` (só tipos, com `import type`), axios nem nada
  de `src/infra`, `src/database`, `src/integrations` ou `src/queue`. Relógio e aleatoriedade entram por
  parâmetro. É testado com Jest puro.
- Controller e processor não têm regra nem acessam o Prisma.
- Módulo de domínio consome outro só pelo que ele **exporta** no `*.module.ts`.
- O service antigo que outros módulos usam fica como **fachada fina** (mesmos métodos) delegando aos
  casos de uso. Nenhuma linha nova entra em fachada.

O módulo do Associado da Sorte segue sendo o modelo de unidade de trabalho com travas explícitas,
`lancar` como única porta do saldo, helpers puros com relógio injetado e erros com `code`.

## 3. Transversais

```
src/
├── config/        leitura de process.env (único lugar): app, tenant, redis, integrações, retenção
├── database/      PrismaService (instância única)
├── shared/        agnóstico de vendor: tenant (contexto e credenciais), erros, semáforo, utils
├── infra/
│   ├── auth/            usuário autenticado, posse por conta, comparação de segredo
│   ├── guards/          JwtAuth, AdminRole, AdminPanelRole, AdminToken, SomenteAssociado
│   ├── observability/   contexto de execução, logger JSON, redação, métricas, /metrics
│   ├── filters/         filtro global de erro
│   ├── rate-limit/      limitador atômico no Redis, políticas, @LimiteDeTaxa
│   ├── redis/           cliente compartilhado, trava distribuída
│   ├── cache/           cache read-through
│   ├── idempotencia/    Idempotency-Key
│   ├── outbox/          outbox + despachante
│   ├── manutencao/      expurgos de retenção
│   ├── pdf/             porta PdfRenderer, Chromium com semáforo, renderização pela fila
│   ├── health/          live, ready
│   ├── mail/  storage/
├── integrations/  um diretório por vendor: hinova, clubgas, expo, alloyal + core (sessão, disjuntor)
└── queue/         nomes e política das filas, produtor, processador base, fila de mortos
```

Módulos globais: `DatabaseModule`, `InfraModule`, `SharedModule`, `RedisModule`, `CacheModule`,
`RateLimitModule`, `QueueModule`, `PdfModule`, `ConsistenciaModule`. Nunca redeclarar os providers
deles em módulo de feature.

## 4. Papéis de processo

`src/config/app.config.ts` lê `APP_ROLE` (`api`, `worker`, `pdf`, `all`; padrão `all`).

- `paraPapel('worker', [XProcessor])` na lista de `providers` do módulo: o processor só existe no
  papel informado.
- Agendador (`upsertJobScheduler`, `repeat`) e reconciliação de boot começam com
  `if (!papelAtivo('worker')) return;`.
- Estado em memória de processo é proibido para o que precisa valer entre processos: sessão de vendor
  (`VendorSessionStore`), limite de requisições (`LimitadorService`), cache (`CacheService`), trava
  (`TravaService`).

O deploy padrão é `all` em um container (`docker-compose.yml`, `docker compose up -d --build api`). A
separação em processos é opcional (`docker-compose.escala.yml` + `ops/deploy.sh`). Limites e roteiro:
`docs/OPERACAO_E_DEPLOY.md`.

## 5. Multi-tenant

Duas dimensões, como sempre: **empresa** (um deploy, um banco e um `.env`) e **base** (`baseOrigin`
dentro do deploy).

- A base é resolvida **uma vez, na borda**: no `JwtStrategy` (claim do token; token antigo sem a claim
  lê `user.baseOrigin`), no payload do job (`baseDoJob`), ou pelo dono do veículo no webhook.
- Dali em diante ela anda **por parâmetro**. Não existe mais `BaseContextService` nem provider em
  escopo REQUEST.
- **Sem base não há operação**: `exigirBase(valor, 'contexto')` lança `BaseNaoResolvidaError` (422,
  `BASE_NAO_RESOLVIDA`). `TENANT.defaultBase` não é fallback — a regra de lint proíbe o uso fora de
  `src/config`.
- Base de token que não pertence ao deploy responde 401.
- Credenciais: `TenantCredentialsRegistry` é o único lugar que conhece nome de env de credencial. Cada
  client pede só a sua (`registry.m7(base)`). Ausente → `IntegrationError` `nao_configurada` (503 com
  `code`), e o boot relata por base o que falta.
- Chaves derivadas (cache, rate limit, sessão, `jobId`) começam pela base; métricas levam o rótulo
  `base`.
- Nas rotas: `@BaseOrigin()` (401 se o token não tiver base) ou `@BaseOrigin({ opcional: true })` para
  a rota que também atende o painel.

## 6. Integrações

Um client por vendor em `src/integrations/<vendor>`, não global, exportando o client (ou a porta).
Service de domínio não importa axios.

| Vendor | Client | O que ele garante |
|---|---|---|
| Hinova (SGA) | `SgaAuthService`, `HinovaClient` | Sessão e bloqueio de token compartilhados no Redis, login sob trava, rotação de tokens de base, timeout padrão, disjuntor por base, cache das leituras repetidas pelo app |
| Expo | porta `PushGateway` (`ExpoPushClient`) | Prazo por chamada, resultado por mensagem, lote que falha não derruba os demais |
| ClubGas | `ClubgasClient` | Timeout e erro classificado (`ClubgasErro`) |
| Alloyal | porta `AlloyalGateway` (`src/integrations/alloyal`) | Timeout, credencial por base, erro classificado |
| M7, Lógica, Softruck | submódulos de `src/rastreamento/<provedor>` (porta `ProvedorDeRastreamento`) | Sessão compartilhada no Redis, credencial resolvida pelo próprio provedor, contrato único testado contra os três |
| Chromium | porta `PdfRenderer` | Um navegador reaproveitado, semáforo, prazo, reciclagem |

Regras: timeout sempre; retry só em leitura; todo recurso criado no vendor leva uma referência nossa,
para reconciliar depois de um timeout; métrica por chamada (`medirVendor`).

## 7. Erros

Três famílias (`src/shared/erros/erros.ts`), com destino conhecido no HTTP e na fila:

| Família | Quando | HTTP | Na fila |
|---|---|---|---|
| `DomainError` | regra de negócio violada | 409 ou 422, com `code` | sem retry, fila de mortos |
| `IntegrationError` | falha de vendor | 502, 503 ou 504 | retry se transitória |
| `InfraError` | banco, Redis, disco, fila | 503 | retry |

O filtro global preserva o corpo de sempre das `HttpException` e acrescenta `requestId`. Erro
desconhecido sai como 500 genérico, com a stack só no log.

`catch` que só loga e segue é proibido: ou o erro é tratado de verdade e o resultado diz que falhou,
ou ele propaga.

Dívida conhecida, por contrato com o app: alguns erros de vendor ainda saem com status de sucesso.
Esses pontos contam em `vendor_erro_como_sucesso_total`; corrigir o status exige alinhar com o app.

## 8. Filas

- Nomes e política de retry por fila em `src/queue/filas.ts`. Padrão: 5 tentativas, backoff
  exponencial a partir de 2 s com jitter. A fila só foge dele com o motivo escrito ao lado.
- Produzir: `ProdutorDeFilas.enfileirar(fila, job, dados, { base, jobId })`. O payload sai com
  `baseOrigin` e `_meta` (`requestId`, versão, data).
- Consumir: estender `ProcessadorBase` e implementar `executar`. A base dá contexto de log, métricas,
  classificação de erro e fila de mortos.
- **Entrega duplicada é assumida.** Todo handler é idempotente pela chave de negócio, e `jobId`
  determinístico barra a duplicata na entrada.
- **Nenhuma fila depende de ordem.** Onde importa (eventos do mesmo veículo), o handler compara a data
  do evento com a do último processado e descarta o antigo.
- **Trabalho por entidade não vira job repetível por entidade.** O estado fica no MySQL e uma
  varredura pega o lote devido com `SKIP LOCKED`.
- Banco e fila juntos: outbox.
- Job que esgota as tentativas vai para a fila de mortos (`/api/admin/filas`).

## 9. Consistência

Padrões que valem para código novo:

1. Mudança de estado é `UPDATE ... WHERE estado IN (...)` com checagem do número de linhas. Quem não
   ganhou a transição não repete efeito.
2. Escrita disparada por toque do usuário aceita `Idempotency-Key` (opcional, para não quebrar versões
   antigas do app).
3. Operação longa sobre uma entidade usa lease com expiração no banco.
4. Rotina que só pode rodar uma vez por vez usa `TravaService`.
5. A constraint única no banco é a última linha de defesa, mesmo onde já existe trava.

## 10. Cache

`CacheService` (Redis): read-through, chave prefixada pela base, expiração obrigatória (o Redis é o
mesmo das filas e roda em `noeviction`), jitter, uma ida à origem por chave em voo, e Redis fora não é
erro. Valor vencido só é servido quando a origem cai **e** o uso pediu isso (`antigoPorSeg`).

Não cachear: saldo e estoque do Associado da Sorte, estado de boleto em geração, resultado de comando
de veículo.

## 11. Segurança

- Toda rota tem guard ou está na lista de rotas públicas, com motivo
  (`src/infra/auth/rotas-publicas.seguranca.spec.ts` falha se surgir rota sem guard).
- Rota de conta: dono ou `role` ADMIN (`exigirDonoOuAdmin`). Nenhuma resposta serializa `passwordHash`.
- Rota só do app recusa token do painel (`SomenteAssociadoGuard`): os dois usam o mesmo segredo e ids
  numéricos.
- Segredo comparado em tempo constante (`segredosIguais`).
- Arquivo só é apagado dentro de `uploads/`; extensão ativa não é gravada; upload tem teto.
- Limite de requisições por política (`@LimiteDeTaxa`); rota autenticada nunca é limitada só por IP.
- Decisões do dono do projeto que NÃO são lacuna: o primeiro acesso é só com o CPF (regra da
  associação) e o rastreamento não checa posse do veículo.

## 12. Observabilidade

Log JSON com `requestId`, `base`, `userId`, rota em template, `queue` e `jobId`; redação de CPF, token
e senha no logger. Métricas em `/metrics` (`src/infra/observability/metricas.ts`). Alertas em
`ops/alertas/regras.yml`. Rótulo de métrica só recebe valor de conjunto fechado: nunca id, CPF, chassi
ou URL.

## 13. Régua de PR

Verificado por ferramenta:

- `npm run lint:arquitetura` (bloqueia o CI): `process.env` só em `src/config`; `TENANT.defaultBase`
  só em `src/config`; axios só em `src/integrations` e nos submódulos de provedor do rastreamento
  (`src/rastreamento/{m7,logica,softruck}`, que são os adaptadores desses vendors); ioredis só em
  `src/infra/redis`; Chromium só em `src/infra/pdf`; SDK do Expo só em `src/integrations/expo`;
  `domain/` puro (de `src/integrations` só importa tipos); controller sem Prisma; transversal não
  importa domínio. As exceções do legado ficam em `eslint.arquitetura.legado.mjs` (26 arquivos que
  ainda leem `process.env` e 6 com import fora da regra, em novembro de 2026) e só diminuem: arquivo
  novo não entra nela.
- `npm run verify`: typecheck, testes e build.
- Inventário de rotas: rota nova sem guard quebra o teste.
- `prisma migrate diff --exit-code` no CI: schema e migrations não divergem.

Verificado por quem revisa:

1. Código novo nasce no arquivo novo, na camada certa. Nada entra em fachada de god service.
2. Integração nova: client em `integrations/<vendor>`, credencial no registry para **todas** as bases,
   env classificada no `env.validator.ts` e documentada no `.env.example`.
3. Job novo: payload com base, handler idempotente, política de retry em `filas.ts`.
4. Mudança de estado com condição no `WHERE`.
5. Teste: domínio sem mock; trava, lease e unique contra o banco real (`docs/TESTES.md`).
6. Contrato do app preservado; campo novo é aditivo.
