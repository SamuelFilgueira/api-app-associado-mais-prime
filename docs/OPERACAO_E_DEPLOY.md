# Operação e deploy do beneficios-api

Como a aplicação sobe a partir de novembro de 2026. Há dois modos, com o mesmo código e a mesma imagem:

| | Deploy padrão | Topologia de escala (opcional) |
|---|---|---|
| Arquivo | `docker-compose.yml` | `docker-compose.escala.yml` |
| Comando | `docker compose up -d --build api` | `ops/deploy.sh <tag>` |
| Aplicação | um container `api` que faz tudo (`APP_ROLE=all`) | `api-1`, `api-2`, `worker`, `pdf` |
| Redis | publicado só em `127.0.0.1:6379`; senha opcional | sem porta; `REDIS_PASSWORD` obrigatória |
| Porta da API | `${PORT:-3001}` como sempre | `127.0.0.1:3001` e `127.0.0.1:3002` |
| Reinício | derruba e sobe o container (segundos de indisponibilidade) | rolling, uma réplica por vez |

O padrão é o modo de sempre. A topologia de escala existe para quando a carga pedir: tira PDF e filas
do processo que atende o app e permite reiniciar sem queda. Os dois arquivos usam os **mesmos volumes**
(`redis-data`, `uploads-data`, `updates-data`, `webhook-data`), então trocar de um para o outro não
perde uploads, releases OTA nem o que está no Redis.

Os arquivos citados ficam versionados em `Dockerfile`, `docker-compose*.yml`, `ops/` e
`.github/workflows/`.

## 1. Deploy padrão

```bash
git pull
npx prisma migrate status      # confira o banco de destino e o que está pendente
npx prisma migrate deploy      # só quando houver migration nova
docker compose up -d --build api
```

Servidor sem Node instalado: `docker compose run --rm migrate` aplica as migrations de dentro da imagem.

O que o `up` faz sozinho:

- sobe (ou recria) o Redis. Ele deixa de ficar aberto na 6379 para a internet: a porta é publicada só
  em `127.0.0.1`. Os dados continuam no volume `redis-data`;
- roda o serviço `volumes-permissoes`, de uma passada, que entrega os volumes ao usuário `node` da
  imagem. A imagem antiga rodava como root; a nova não. Depois da primeira vez ele só confere e sai;
- constrói a imagem e sobe o container `api` com todos os papéis.

Senha no Redis é opcional neste modo: com `REDIS_PASSWORD` no `.env`, o Redis sobe exigindo a senha e
a aplicação a usa; sem ela, sobe sem senha.

Desenvolvimento na própria máquina, com a API fora do Docker: `docker compose up -d redis` e
`npm run start:dev` (o `.env` aponta para `localhost:6379`).

### Primeira vez com esta versão

O código novo depende de cinco migrations (`20261126090000` a `20261126130000`). Elas só acrescentam
colunas anuláveis, tabelas e índices, e tornam anulável uma coluna de tabela nova. **Aplique antes de
subir.** A doc de clonagem registra o baseline `0_init` como pendente em produção: resolva isso
primeiro (`prisma migrate resolve --applied 0_init`, depois de conferir que o esquema corresponde). A
migration de índices consome I/O — aplique fora do pico.

### Conferências no banco antes da primeira implantação

Rode em produção (somente leitura) e avalie o resultado antes de subir:

```sql
-- 1. Associados sem base válida: passam a receber 401/422 onde antes caíam na base padrão.
SELECT baseOrigin, COUNT(*) FROM user GROUP BY baseOrigin;

-- 2. Chassis fora do padrão: recebem 400 em /sga/veiculos-info/:chassi e /sga/set-revistoria
--    (o veículo não consegue fazer revistoria).
SELECT COUNT(*) FROM UserVehicle WHERE chassi NOT REGEXP '^[A-Za-z0-9]{6,20}$';

-- 3. Régua de boletos: linhas antigas que voltam a ser elegíveis e serão REENVIADAS na primeira
--    execução, se o boleto ainda estiver na faixa da etapa.
SELECT tipoMensagem, statusEnvio, COUNT(*), MIN(criadoEm)
  FROM BoletoNotificacaoLog
 WHERE expoTicketId IS NULL
   AND (statusEnvio = 'ENFILEIRADO' OR (statusEnvio = 'FALHA' AND expoErro LIKE 'SEND_ERROR:%'))
 GROUP BY 1, 2;

-- 4. Disparos de marketing parados: na primeira varredura viram FAILED.
SELECT status, COUNT(*), MIN(createdAt) FROM MarketingNotificationAuditLog
 WHERE status IN ('REQUESTED', 'SENDING') GROUP BY 1;
```

### O que não tem volta simples

- **Rollback do código.** Boleto criado nesta versão é verificado pela varredura, não por job repetível:
  o código anterior não acompanharia o pagamento dele. Se for preciso voltar, liste os boletos criados
  no período (`ReinspectionPayment.proximaConsultaEm IS NOT NULL AND pago = false`) e acompanhe à mão.
- **Estado de âncora e alerta de ignição** passa a ser por veículo. No deploy todo veículo herda o
  valor da conta; em quem tem mais de um carro, o primeiro comando em cada veículo ainda envia à M7 o
  valor herdado no campo que não foi pedido.
- **Imagem como usuário `node`.** Depois que os volumes mudam de dono, a imagem antiga (root) continua
  conseguindo ler e gravar neles; não há o que desfazer.

### Jobs que já estão no Redis

No instante do deploy existem jobs enfileirados pela versão antiga. Os processors continuam aceitando
os payloads antigos (sem `baseOrigin`, sem `_meta`): a base é lida do banco, como antes. Os jobs
repetíveis de verificação de boleto criados pela versão antiga seguem rodando até encerrarem.

## 2. Papéis de processo

A mesma imagem roda em quatro modos, escolhidos por `APP_ROLE`:

| `APP_ROLE` | O que faz | Chromium |
|---|---|---|
| `all` | Tudo junto. É o padrão: deploy de container único e desenvolvimento | sim |
| `api` | HTTP público (`/api`). Só **produz** jobs | não usa |
| `worker` | Consome as filas e roda os agendadores (régua de boletos, varreduras, outbox, expurgos) | não usa |
| `pdf` | Consome só a fila `pdf-render` | sim |

Todos sobem o servidor HTTP na `PORT` com `/health/live`, `/health/ready` e `/metrics`. No papel `api`,
um relatório em PDF é pedido pela fila ao processo `pdf` e a rota continua devolvendo o PDF na mesma
requisição (prazo: `PDF_PRAZO_MS`).

Só os papéis `worker` e `all` registram processors e agendadores. Um processo `api` nunca cria nem
remove agendador.

## 3. Topologia de escala (opcional)

| Serviço | Réplicas | CPU | Memória | Pool do Prisma | Observação |
|---|---|---|---|---|---|
| `api-1`, `api-2` | 2 | 1,0 cada | 1 GB cada | 10 cada | `127.0.0.1:3001` e `:3002`; o Nginx do host faz o upstream |
| `worker` | 1 | 1,0 | 1,5 GB | 10 | porta só na rede interna |
| `pdf` | 1 | 1,0 | 3 GB | 2 | a memória é do Chromium |
| `redis` | 1 | 0,5 | 1,5 GB | — | sem porta publicada, `requirepass`, `noeviction`, teto de 1 GB |
| MySQL | host | — | 5 GB | — | fora do compose |

O pool por processo soma 32 conexões. Com o pool antigo (40 por processo), quatro processos passariam
do `max_connections` padrão do MySQL (151).

O volume extra `pdf-tmp` é a troca de arquivos entre as réplicas da API e o processo `pdf` (o HTML vai
e o PDF volta por arquivo; só o identificador passa pelo Redis).

Antes de escalar o `worker` para duas instâncias, confirme que as varreduras toleram rodar em dobro
(as que existem usam `SKIP LOCKED` ou trava no Redis; rotina nova precisa do mesmo cuidado).

### Passar do deploy padrão para a topologia de escala

Não é rolling: o container `api` ocupa a porta 3001 e o Redis passa a exigir senha. Exige uma janela
curta. **Este roteiro foi validado por partes (compose, imagem, script) e não contra um servidor real:
ensaie em homologação antes.**

1. **Redis.** Confira o `used_memory` atual (`redis-cli info memory`). Nesta topologia o Redis sobe com
   `maxmemory 1gb` e `noeviction`: se já houver mais de 1 GB, ele recusa escrita assim que subir.
2. **Nginx.** Instale `ops/nginx/beneficios-api.conf`, preencha `server_name` e os caminhos do
   certificado, `nginx -t`, recarregue.
3. **`.env`.** Acrescente `REDIS_PASSWORD` (`openssl rand -hex 32`).
4. **Imagem.** `docker pull <imagem>`, ou `docker build` na VPS (abaixo).
5. `docker compose down --remove-orphans` — **nunca com `-v`** (apaga os volumes).
6. `APP_IMAGE_REPO=ghcr.io/<dono>/<repo> ops/deploy.sh <sha>` (ou `SEM_PULL=1 ops/deploy.sh
   beneficios-api:<sha>` com a imagem local).

O `deploy.sh` roda as migrations (serviço `migrate`), acerta o dono dos volumes e sobe `worker`, `pdf`,
`api-1` e `api-2`, nessa ordem, esperando cada um ficar saudável. API e worker precisam subir juntos: a
API só enfileira.

Para voltar ao deploy padrão: `docker compose -f docker-compose.escala.yml down --remove-orphans` e
`docker compose up -d --build api`. O Redis volta a aceitar conexão conforme o `.env` (com ou sem
`REDIS_PASSWORD`).

### Deploys seguintes na topologia de escala (rolling)

```bash
APP_IMAGE_REPO=ghcr.io/<dono>/<repo> ops/deploy.sh <sha-do-commit>
```

A imagem pode ser construída no CI (`.github/workflows/ci.yml`, job de imagem na `main`) e publicada no
registry; a VPS só faz `pull`. Se uma réplica nova não ficar saudável, o script devolve aquele serviço
à imagem anterior e para.

Sem registry, construa na VPS com uma tag por commit e peça para o script não baixar:

```bash
git pull
docker build -t beneficios-api:$(git rev-parse --short HEAD) .
SEM_PULL=1 ops/deploy.sh beneficios-api:$(git rev-parse --short HEAD)
```

Durante o rolling convivem código antigo e novo sobre o mesmo banco, já migrado. Toda migration
precisa ser compatível com a versão anterior: expandir primeiro; remover coluna ou tabela só em um
deploy posterior.

## 4. Variáveis de ambiente novas

Todas documentadas no fim do `.env.example` e em `src/config/env.validator.ts`. Nenhuma é obrigatória
no deploy padrão. As que merecem atenção:

| Variável | Ação |
|---|---|
| `REDIS_PASSWORD` | Opcional no deploy padrão; **obrigatória** na topologia de escala. `openssl rand -hex 32` |
| `CORS_ORIGINS` | Origens do painel, separadas por vírgula. Sem ela o CORS segue aberto, com aviso no boot |
| `METRICS_TOKEN` | Opcional. Sem ela `/metrics` responde só a rede interna |
| `SWAGGER_ENABLED` | Em produção `/docs` só sobe com `true` |
| `RATE_LIMIT_ENFORCE_ALL` | Deixe `false` até calibrar (seção 7) |
| `HINOVA_CACHE_*`, `HINOVA_ORCAMENTO_POR_MINUTO` | Padrões servem; ver seção 8 |
| `ALLOYAL_CACHE_*_SEG` | Cache do catálogo do clube (categorias 6 h, destaques 3 h, organizações 1 h). `0` desliga sem deploy |
| `RETENCAO_*` | Expurgo de tabelas de negócio é **desligado** por padrão (seção 10) |

`ADMIN_PANEL_TOKEN` passou a proteger `POST /api/auth/register` e `POST /api/rastreamento/renovar-token`
(header `x-admin-token`).

## 5. Proxy

O deploy padrão continua atrás do Nginx que já existe no servidor; nada muda nele. O arquivo
`ops/nginx/beneficios-api.conf` é uma configuração de referência (limite por IP, tamanho de corpo por
rota, `X-Request-Id`, bloqueio de `/metrics`) pensada para a topologia de escala: usando-o no deploy
padrão, deixe no `upstream` só a linha da porta 3001.

## 6. Sondas, métricas e alertas

| Rota | Uso |
|---|---|
| `GET /health/live` | O processo responde. É o `HEALTHCHECK` do container |
| `GET /health/ready` | MySQL e Redis respondem; 503 na falha. Usada pelo deploy e pelo compose |
| `GET /health` | Formato antigo, mantido (sempre 200) |
| `GET /metrics` | Prometheus. Rede interna, ou Bearer com `METRICS_TOKEN`. O Nginx bloqueia para fora |

Métricas e regras de alerta: `src/infra/observability/metricas.ts` e `ops/alertas/regras.yml` (os
nomes são contrato entre os dois arquivos). Como carregar as regras e o que depende de exporters
externos (Redis, MySQL, disco): `ops/alertas/README.md`.

Logs: uma linha JSON por evento no stdout (`LOG_FORMAT=json`), com `requestId`, `base`, `userId`,
`rota`, `queue` e `jobId`. O `X-Request-Id` do Nginx é aceito e devolvido na resposta; o corpo de todo
erro traz `requestId`. CPF, token e senha são mascarados no logger.

O que ainda falta decidir: o backend que guarda métricas e logs (gerenciado ou auto-hospedado). Até lá
`/metrics` e os logs JSON estão prontos para qualquer coletor.

**Tracing distribuído (OpenTelemetry) não foi implementado**: sem um backend escolhido não há para onde
enviar os spans. O que existe é a correlação por `requestId`, que acompanha a requisição do proxy até
o log de cada job que ela enfileirou (`_meta.requestId` no payload). Quando o backend for definido, a
instrumentação entra como primeiro import do `main.ts`, sem tocar no restante.

## 7. Limite de requisições

Dois níveis: o Nginx aplica um limite grosso por IP; a aplicação aplica políticas por rota no Redis
(`src/infra/rate-limit/rate-limit.politicas.ts`).

| Política | Rotas | Modo de partida |
|---|---|---|
| `autenticacao` | login do app e do painel | aplica (só falhas contam) |
| `recuperacao_senha`, `primeiro_acesso` | reset de senha, primeiro acesso | aplica |
| `relatorio` | PDFs | aplica (3/min e 1 por vez por usuário) |
| `comando` | âncora e alerta de ignição | aplica |
| `leitura`, `sga`, `posicao` | demais rotas autenticadas | **observa** |

As políticas em observação só medem (`rate_limit_hits_total{politica,resultado="observado"}`). Depois
de alguns dias olhando a métrica, ajuste os números e ligue `RATE_LIMIT_ENFORCE_ALL=true`.

Com o Redis fora, as políticas de abuso continuam valendo por processo (contagem em memória) e as
demais liberam.

## 8. Hinova (SGA)

- **Cache** das leituras repetidas pelo app (`HinovaClient`): associado 5 min, boletos 2 min, produtos
  do veículo 6 h. Só resposta 200 com JSON entra no cache. Pagamento detectado, reativação e geração
  de boleto invalidam a chave.
- **Valor antigo quando a Hinova cai**: desligado (`HINOVA_CACHE_ANTIGO_SEG=0`). Ligar é decisão de
  produto, tela a tela.
- **Sessão e bloqueio de token** ficam no Redis, compartilhados entre os processos; o login roda sob
  trava (um processo autentica, os outros reaproveitam).
- **Disjuntor**: cinco falhas de transporte seguidas abrem o circuito da base por 30 s (as chamadas
  falham na hora, com 503).
- **Orçamento por token**: `HINOVA_ORCAMENTO_POR_MINUTO=0` só mede. Defina um valor abaixo do ponto em
  que os bloqueios aparecem em `hinova_token_bloqueado_total`.

## 9. Filas

Nomes e política de retry por fila: `src/queue/filas.ts`. Job que esgota as tentativas, ou falha com
erro definitivo, é copiado para a fila de mortos e incrementa `dlq_jobs_total` (alerta a qualquer job
novo).

Operação pelo painel (perfil ADMIN):

| Rota | O que faz |
|---|---|
| `GET /api/admin/filas` | Jobs por fila e estado; mortos por fila |
| `GET /api/admin/filas/mortos?fila=&limite=` | Lista os mortos (payload com dados sensíveis mascarados) |
| `POST /api/admin/filas/mortos/:id/reprocessar` | Devolve o job à fila de origem |
| `DELETE /api/admin/filas/mortos/:id` | Descarta |

## 10. Manutenção e retenção

Agendadores que só o papel `worker` registra: expurgo diário e limpeza do diretório de PDF (fila
`manutencao`), despacho do outbox, varredura de verificação de pagamento de boleto e de retry do boleto
de reativação (60 s), varredura dos disparos de push (1 min), régua de boletos (diária) e o ciclo do
Associado da Sorte (se ligado).

Fila `manutencao`:

- **expurgo diário às 03:30** (horário de Brasília), em lotes, sob trava (uma rodada por vez). Módulo
  com expurgo próprio registra a rotina na manutenção (`ExpurgoService.registrarRotina`) — é o caso da
  jornada do analytics (`ANALYTICS_JOURNEY_ENABLED=true`, retenção `ANALYTICS_JOURNEY_TTL_DAYS`).
  Tabelas técnicas têm padrão ligado
  (outbox publicado há 7 dias, entregas de push de disparos concluídos há 90 dias, chaves de
  idempotência vencidas). Tabelas de **negócio** (`Notification`, `VehicleWebhookEvent`,
  `AppVersionValidationLog`, `AnalyticsSummaryReceipt`) só são expurgadas se a `RETENCAO_*`
  correspondente for definida;
- **limpeza do diretório de troca de PDF** a cada 10 minutos.

A env antiga `ANALYTICS_RECEIPTS_TTL_DAYS` (presente no `.env.example` desde antes) nunca foi lida pelo
código e continua sem efeito, de propósito.

## 11. Ações operacionais pendentes da contenção de segurança

Não são código; dependem de quem opera:

1. Rotacionar as credenciais da M7 de todas as bases (a rota que as devolvia estava aberta).
2. Rotacionar o `ADMIN_PANEL_TOKEN`.
3. Procurar nos logs do proxy chamadas sem `Authorization` a `GET /api/associado/:id`,
   `GET /api/associado/cpf` e `POST /api/rastreamento/renovar-token` anteriores a esta versão.
4. `git rm --cached` dos payloads reais de webhook já foi feito (ficou no stage); avaliar a limpeza do
   histórico do git.
5. Rotacionar o `JWT_SECRET` é decisão em aberto: derruba todas as sessões do app.
