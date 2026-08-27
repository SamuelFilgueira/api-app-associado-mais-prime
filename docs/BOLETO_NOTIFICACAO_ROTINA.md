# Rotina Diária de Notificações Push de Boletos (SGA)

> **Data:** 2026-08-25 · **Módulo:** `src/boleto-notificacao/` · **Endpoint SGA:** `POST /listar/boleto-associado/periodo`

Rotina agendada que, todo dia, consulta no SGA os boletos **ABERTOS** cujo `data_vencimento_original` cai nos dias fixos configurados e dispara push (Expo) em três momentos do ciclo de cobrança: **D0**, **D+5** e **D+6**. Cobre 100% da base por consulta paginada — sem precisar enumerar veículos ou associados.

## 1. Regra de negócio implementada

| Momento | Data-alvo consultada | Filtro SGA | Mensagem padrão (configurável) |
|---|---|---|---|
| D0 | `hoje` | `codigo_situacao_boleto = 2` (ABERTO) | "Boleto disponível para pagamento" |
| D+5 | `hoje − 5` dias corridos | idem | "Seu boleto ainda está em aberto" |
| D+6 | `hoje − 6` dias corridos | idem | "Você está desprotegido" |

- O ciclo é ancorado em **`data_vencimento_original`** (reemissão não desloca).
- Um momento só é consultado se a data-alvo for **dia de gatilho** (5/10/15/20/25/30). Feriado/fim de semana não desloca.
- **Meses curtos:** quando o dia fixo não existe (30 em fevereiro), o dia de fallback (default **28**) entra no lugar; o ciclo D0/D+5/D+6 desses boletos conta a partir de 28/02. Ex.: em 05/03, D+5 consulta 28/02 e dispara.
- **Boleto pago no meio do ciclo:** o filtro `situacao = 2` no momento do disparo já exclui BAIXADO (1), CANCELADO (3), BAIXADO C/ PENDÊNCIA (4) e EXCLUÍDO (999). Não há lógica extra de cancelamento. Um filtro local defensivo (situação + data) descarta qualquer divergência do SGA.
- **1 push por associado** por (tipo, vencimento): N boletos/veículos do mesmo `codigo_associado` viram um único push (`quantidadeBoletos` fica no log). Se dois `codigo_associado` diferentes resolverem para o mesmo usuário do app, só o primeiro recebe (`totalDuplicadosUsuario`).
- **Idempotência:** unique `(tenant, codigoAssociado, dataVencimentoOriginal, tipoMensagem)` em `BoletoNotificacaoLog`. Reprocessar o mesmo dia não duplica push; execuções concorrentes são barradas pela constraint (P2002 tratado).
- **Casamento com o app:** CPF do boleto normalizado (só dígitos, 11 posições) → `user.cpf` (único na base). Usuário com `baseOrigin` de outro tenant é ignorado; `baseOrigin` nulo (legado) é aceito. Só `isActive` e com `expoPushToken` válido.
- **Deep-link:** `data = { type: "internal_route", screen: "financeiro", ... }` — mesmo fluxo do push por CPF; o app abre a área financeira (1 veículo → boletos direto; vários → seleção).
- **Situação do boleto:** tabela oficial em `enums/situacao-boleto-sga.enum.ts`. O mapa antigo em `reinspection-payments-admin.service.ts` (com "5 = Vencido") é **isolado** ao admin de revistoria (só rótulo de exibição) e **não** é usado aqui.

## 2. Arquitetura

```
src/boleto-notificacao/
├── boleto-notificacao.module.ts
├── config/boleto-notificacao.config.ts          # envs → config validada (defaults)
├── enums/situacao-boleto-sga.enum.ts            # tabela oficial SGA
├── helpers/ciclo-cobranca.helper.ts             # dias efetivos (28⇒30), data-alvo, CPF, placeholders
├── interfaces/sga-boleto-periodo.interface.ts
├── services/sga-boleto-periodo.client.ts        # consulta paginada + parser defensivo + mock
├── services/boleto-notificacao.service.ts       # orquestração: consulta → agrupa → casa → idempotência → envia → log
├── services/boleto-notificacao-receipts.service.ts  # receipts Expo → ENTREGUE/FALHA, cobertura de entrega
├── services/boleto-notificacao-scheduler.service.ts # repeatable BullMQ (cron) no boot
├── processors/boleto-notificacao.processor.ts   # worker: executar-rotina / verificar-receipts
├── controllers/boleto-notificacao-admin.controller.ts
└── dto/executar-rotina.dto.ts
```

Reaproveitado: `SgaAuthService.executeRequestWithAuth` (auth + reautenticação em 401, por tenant), `TENANT.baseNames`, fila BullMQ (`BOLETO_NOTIFICACAO_QUEUE`), histórico `notification` do app, deep-link financeiro. Extraído para `src/shared/date.util.ts`: `formatDateBR` (antes duplicado em `boleto.service.ts` e `boleto-verificacao.processor.ts`) + `parseDateBR`, `addDays`, `toUtcDateOnly`.

### Fluxo por execução (tenant × tipo)

1. `dataAlvo = hoje − offset`; se não é gatilho → execução `PULADA`.
2. `POST /listar/boleto-associado/periodo` com `data_vencimento_original_inicial = final = dataAlvo`, `codigo_situacao_boleto = 2`, `quantidade_por_pagina = 500`, `inicio_paginacao = 0, 1, 2…`
3. Agrupa por `codigo_associado`, casa CPF → `user`, aplica idempotência, monta mensagens.
4. Grava logs `ENFILEIRADO`, envia em lotes de 100 (`expo.chunkPushNotifications`), atualiza `ENVIADO`/`FALHA` por ticket, grava histórico do app.
5. Agenda `verificar-receipts` (default 15 min; até 3 tentativas) → `ENTREGUE`/`FALHA`, `DeviceNotRegistered` limpa o token do usuário.
6. Persiste métricas em `BoletoNotificacaoExecucao`.

### Paginação (ponto de atenção)

`inicio_paginacao` é índice de página **base-0**; `pagina_corrente` do retorno aparenta ser **base-1**. O loop itera `0 .. numero_paginas − 1` e para por **qualquer** critério: cobriu `numero_paginas`, página vazia, ou acumulado ≥ `total_registros`. Boletos repetidos entre páginas (ordenação instável) são descartados e logados. **Validar em homologação** com um dia que tenha > 500 boletos: o log mostra `total_registros`, `numero_paginas` e o acumulado por página.

Parser defensivo: `total_registros` string → número; chave `"mostrando "` (com espaço) normalizada; `codigo_situacao_boleto` comparado como string; CPF normalizado; retorno em array puro também aceito.

**Formato real confirmado em 26/08/2026 (difere da doc):** o SGA responde as datas em **`yyyy-mm-dd`** (`data_vencimento_original: "2026-09-10"`), não em `dd/mm/yyyy`; `"0000-00-00"` é usado como "sem data". O campo `cpf` traz **CNPJ (14 dígitos)** para associados pessoa jurídica. O parser (`parseDateSga` em `src/shared/date.util.ts`) aceita os dois formatos de data e `normalizarCpf` aceita 11 ou 14 dígitos. Os parâmetros de **entrada** continuam em `dd/mm/yyyy`.

## 3. Modelo de dados

**`BoletoNotificacaoExecucao`** — 1 linha por execução × tenant × tipo: `status` (EM_ANDAMENTO/CONCLUIDA/PULADA/FALHA), `origem` (AGENDADA/MANUAL), contadores e as duas coberturas.

**`BoletoNotificacaoLog`** — 1 linha por push: `tenant`, `codigoAssociado`, `cpf`, `userId`, `nossoNumero` (1º boleto), `quantidadeBoletos`, `dataVencimentoOriginal`, `tipoMensagem` (D0/D5/D6), `expoPushToken`, `statusEnvio` (ENFILEIRADO/ENVIADO/ENTREGUE/FALHA), `expoTicketId`, `expoErro`, `mensagemTitulo`, `mensagemEnviada`, timestamps. **Unique de idempotência** nos 4 campos-chave.

Migration: `prisma/migrations/20260825120000_boleto_notificacao_rotina/`.

## 4. Métricas (por execução, tenant, dia e tipo)

| Métrica | Fórmula | Campo |
|---|---|---|
| **Cobertura de elegíveis** | pushes enfileirados ÷ associados elegíveis encontrados no SGA | `coberturaElegiveis` |
| **Cobertura de entrega** | pushes ENTREGUE (receipt ok) ÷ pushes enfileirados | `coberturaEntrega` |

Contadores: `totalRegistrosSga`, `totalPaginasSga`, `totalBoletosElegiveis`, `totalAssociados`, `totalSemUsuario`, `totalSemToken`, `totalIdempotentes`, `totalDuplicadosUsuario`, `totalEnfileirados`, `totalEnviados`, `totalEntregues`, `totalFalhas`, `totalTokensInvalidos`. Consulta: `GET /api/boleto-notificacao/admin/execucoes`.

## 5. Configuração (env — todas com default)

| Env | Default | Descrição |
|---|---|---|
| `BOLETO_NOTIFICACAO_ENABLED` | `false` | Liga o agendamento diário. Execução manual funciona sempre. |
| `BOLETO_NOTIFICACAO_HORARIO` | `09:00` | HH:mm em America/Sao_Paulo |
| `BOLETO_NOTIFICACAO_DIAS_VENCIMENTO` | `5,10,15,20,25,30` | Dias fixos |
| `BOLETO_NOTIFICACAO_OFFSET_D5` / `_D6` | `5` / `6` | Dias corridos após o vencimento |
| `BOLETO_NOTIFICACAO_FALLBACK_MES_CURTO` | `28` | Dia usado quando o fixo não existe no mês |
| `BOLETO_NOTIFICACAO_MSG_{D0,D5,D6}_{TITULO,CORPO}` | ver `.env.example` | Placeholders `{vencimento}`, `{quantidade}` |
| `BOLETO_NOTIFICACAO_QTD_POR_PAGINA` | `500` | |
| `BOLETO_NOTIFICACAO_RECEIPTS_DELAY_MIN` | `15` | |
| `BOLETO_NOTIFICACAO_TENANTS` | todas de `TENANT_BASES` | Subconjunto |
| `BOLETO_NOTIFICACAO_SGA_MOCK_FILE` | — | **Dev only**: JSON no lugar do SGA |
| `SGA_API_BASE_URL` | `https://api.hinova.com.br/api/sga/v2` | |

Alterar horário/mensagens exige restart (config lida no boot); `POST .../agendamento/sincronizar` re-registra o cron sem restart se a env já foi alterada no processo.

## 6. Endpoints administrativos (JWT com role `ADMIN`)

Prefixo: `/api/boleto-notificacao/admin`

| Método | Rota | Função |
|---|---|---|
| GET | `/config` | Config efetiva, estado do cron no Redis, dias efetivos do mês atual e de fevereiro |
| GET | `/simular-datas?dataReferencia=dd/mm/yyyy` | Datas-alvo e gatilhos de D0/D5/D6 |
| POST | `/executar` | Dispara a rotina. Body: `{ dataReferencia?, tenants?, tipos?, dryRun?, sync? }` |
| GET | `/execucoes?limit=&tenant=` | Execuções com métricas |
| GET | `/execucoes/:id` | Execução + contagem de logs por status |
| GET | `/execucoes/:id/logs?status=&limit=` | Logs (CPF mascarado) |
| POST | `/execucoes/:id/verificar-receipts` | Força a verificação de receipts |
| POST | `/agendamento/sincronizar` | Re-registra o repeatable no Redis |

## 7. Guia de teste local (dev) — antes de subir

### 7.1 Pré-requisitos

```bash
# Redis + MySQL locais (docker compose já sobe o Redis)
docker compose up redis -d
npx prisma migrate status        # deve mostrar "Database schema is up to date!"
npx prisma generate
npm run build && npx jest src/boleto-notificacao   # 21 testes unitários
```

Obtenha um JWT de usuário com `role = ADMIN` (login normal em `POST /api/auth/login`) e exporte: `export JWT=...`.

### 7.2 Passo 1 — sem SGA e sem push: validar datas e config

```bash
curl -s -H "Authorization: Bearer $JWT" localhost:3001/api/boleto-notificacao/admin/config | jq
curl -s -H "Authorization: Bearer $JWT" "localhost:3001/api/boleto-notificacao/admin/simular-datas?dataReferencia=05/03/2026" | jq
# Esperado: D0 05/03 gatilho=true · D5 28/02 gatilho=true (fallback do 30) · D6 27/02 gatilho=false
curl -s -H "Authorization: Bearer $JWT" "localhost:3001/api/boleto-notificacao/admin/simular-datas?dataReferencia=11/03/2026" | jq
# Esperado: D0 false · D5 06/03 false · D6 05/03 true
```

### 7.3 Passo 2 — com MOCK do SGA e dry-run (nada é enviado nem gravado)

1. No `.env`: `BOLETO_NOTIFICACAO_SGA_MOCK_FILE=test/fixtures/sga-boletos-periodo.mock.json` e reinicie (`npm run start:dev`). O log deve mostrar `MOCK_SGA=...`.
2. Garanta no banco local um usuário com CPF `52998224725`, `isActive = 1`, `baseOrigin = 'MAIS_PRIME'` (ou nulo) e **seu** `expoPushToken` real (registre pelo app apontando para o backend local, ou grave via Prisma Studio: `npx prisma studio`).
3. Dry-run do D0 para a data da fixture (10/03/2026):

```bash
curl -s -X POST localhost:3001/api/boleto-notificacao/admin/executar \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"dataReferencia":"10/03/2026","tenants":["MAIS_PRIME"],"tipos":["D0"],"dryRun":true,"sync":true}' | jq
```

Esperado no `resultados[0]`: `status: "DRY_RUN"`, `origemDados: "MOCK"`, `metricas.totalRegistrosSga: 3` (o boleto BAIXADO da fixture é filtrado pelo mock), `totalAssociados: 2`, `totalEnfileirados: 1` (CPF `52998224725`, `quantidadeBoletos: 2` — os dois boletos do associado 10001 viraram um push), `totalSemUsuario: 1` (CPF `01234567890` sem cadastro) e `amostraDestinatarios` com seu `userId`.

### 7.4 Passo 3 — envio real para o seu celular (ainda com mock)

```bash
curl -s -X POST localhost:3001/api/boleto-notificacao/admin/executar \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"dataReferencia":"10/03/2026","tenants":["MAIS_PRIME"],"tipos":["D0"],"sync":true}' | jq
```

- O push "Boleto disponível para pagamento" chega no celular; ao tocar, o app abre a área financeira.
- `GET /execucoes` mostra a execução `CONCLUIDA` com `totalEnviados: 1`, `coberturaElegiveis: 0.5`.
- **Idempotência:** repita o mesmo comando → `totalIdempotentes: 1`, `totalEnfileirados: 0`, nenhum push novo.
- **Receipts:** após ~15 min o job `verificar-receipts` roda sozinho; para não esperar: `POST /execucoes/{id}/verificar-receipts` → log vira `ENTREGUE` e `coberturaEntrega` é preenchida.
- **Token inválido:** troque o `expoPushToken` do usuário por um token sintático válido mas inexistente (`ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`), apague o log anterior (ou use outra `dataReferencia`/tipo) e execute: o ticket/receipt retorna `DeviceNotRegistered`, o log fica `FALHA` e o token é limpo no usuário.
- **Fevereiro:** edite a fixture para `data_vencimento_original: "28/02/2026"` e execute com `dataReferencia: "05/03/2026"`, `tipos: ["D5"]`.

### 7.5 Passo 4 — homologação contra o SGA real (sem push)

1. Remova `BOLETO_NOTIFICACAO_SGA_MOCK_FILE` e reinicie.
2. Dry-run em um dia de vencimento recente com volume (ex.: o último dia 10):

```bash
curl -s -X POST localhost:3001/api/boleto-notificacao/admin/executar \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"dataReferencia":"10/08/2026","tipos":["D0"],"dryRun":true,"sync":true}' | jq '.resultados[] | {tenant,tipo,dataAlvo,status,origemDados,metricas}'
```

3. Confira no log da API: `total_registros`, `numero_paginas`, quantidade por página e acumulado — **confirme empiricamente o critério de parada da paginação** (registros únicos = `total_registros`, sem aviso de duplicados). Se aparecer `boleto(s) repetido(s) entre páginas`, a ordenação do SGA é instável e vale reportar à Hinova.
4. Compare `totalSemUsuario`/`totalSemToken` com a expectativa da base (associados sem app ou sem push). Isso é a **cobertura de elegíveis** real que a operação terá.
5. Se a Hinova limitar requisições, o erro aparece como `HTTP 429` no log/`erro` da execução; nesse caso reduza `BOLETO_NOTIFICACAO_QTD_POR_PAGINA` ou aplique throttle (ponto em aberto, ver §8).

### 7.6 Passo 5 — agendamento

1. `BOLETO_NOTIFICACAO_ENABLED=true` e `BOLETO_NOTIFICACAO_HORARIO=<daqui a 2 min>`; reinicie.
2. `GET /config` → `agendamento.registradoNoRedis: true` e `proximaExecucao` correta (fuso SP).
3. Aguarde o horário: o log mostra `job ... (AGENDADA) iniciado` e `GET /execucoes` traz as 3 × N execuções (`origem: "AGENDADA"`), com `PULADA` nos momentos sem gatilho.
4. Volte `ENABLED=false` no dev para não disparar pushes locais sem querer.

### 7.7 Checklist para produção

- [ ] `BOLETO_NOTIFICACAO_ENABLED=true` **somente** no ambiente de produção; `HORARIO` acordado com a cobrança.
- [ ] Migration aplicada (`npx prisma migrate deploy`).
- [ ] Textos das mensagens revisados pelo produto (envs `MSG_*`).
- [ ] Redis compartilhado entre réplicas (o `jobId` fixo evita cron duplicado).
- [ ] Primeiro dia em produção: acompanhar `GET /execucoes` e as coberturas.

## 8. Itens assumidos — validar com produto/Hinova

1. **Paginação base-0 vs `pagina_corrente` base-1** — implementado com múltiplos critérios de parada; confirmar em homologação (§7.5).
2. **1 push por associado** (agregação) — default implementado; se o produto preferir 1 push por boleto, trocar a chave de agregação/idempotência para incluir `nossoNumero`.
3. **D0 filtra ABERTO** — implementado (não anuncia boleto já pago no mesmo dia).
4. **Tenant do usuário** — `baseOrigin` nulo é aceito (legado); confirmar se há usuários assim e se deveriam ser saneados.
5. **Rate limit da Hinova** — não há throttle; adicionar se aparecer 429.
6. **Mapa de situação de revistoria** (`5 = Vencido`) — isolado; corrigir os rótulos para a tabela oficial é uma melhoria separada.
