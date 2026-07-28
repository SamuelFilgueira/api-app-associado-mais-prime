# Analytics Mobile - Validacao da Implementacao e Guia de Tabelas

Data: 2026-07-06
Escopo: backend NestJS + Prisma + BullMQ

## 1. Resumo executivo

A implementacao de analytics esta consistente com a arquitetura descrita no documento principal:
- Ingestao assincrona via BullMQ
- Sanitizacao e filtragem por allowlist
- Rejeicao de chaves proibidas
- Hash server-side de install/session
- Agregacao diaria por telas, acoes, formularios e sessoes

Porem, foi encontrado um bloqueio de ambiente no banco local: as migrations de analytics ainda nao estao aplicadas. Isso impede a persistencia correta de dados de analytics no ambiente atual.

## 2. Validacao do fluxo implementado

### 2.1 Entrada de dados
- Endpoint de ingestao: POST /api/analytics/summaries
- Guard JWT opcional (aceita sem token)
- Validacoes:
  - Tamanho maximo do payload
  - Schema DTO
  - Janela de periodo <= 1h
  - Scanner recursivo de chaves proibidas
- Rate limit:
  - Por IP
  - Por installHash

### 2.2 Privacidade
- session_id e anonymous_install_id nao sao persistidos em formato bruto
- Sao transformados em HMAC-SHA256 antes de qualquer escrita
- Campos fora de allowlist sao descartados sem quebrar o restante

### 2.3 Processamento assincrono
- Job process-summary na fila analytics-summaries
- Processor grava recibo tecnico e faz upsert das tabelas agregadas
- Deduplicacao de sessao/instalacao por chaves unicas compostas

### 2.4 User linking controlado por flag
- Flag usada: ANALYTICS_LINK_USER_ENABLED
- Regra implementada:
  - true: tenta salvar analyticsUserId a partir do JWT autenticado
  - false: grava analyticsUserId como null

## 3. Por que userId pode nao ser capturado

Foram identificados fatores tecnicos importantes:

1) Endpoint opcional e dependencia de JWT valido no proprio request
- O endpoint aceita requests anonimos por design.
- Se o app nao enviar Authorization: Bearer <token> valido no POST de summaries, req.user fica vazio e analyticsUserId sera null mesmo com a flag ativa.

2) Possivel variacao no caminho de extracao do id do JWT
- Em alguns cenarios, o guard opcional pode nao popular req.user como esperado.
- Foi aplicada uma melhoria de robustez no controller para fallback seguro: quando req.user nao vem preenchido, o backend verifica o token recebido e extrai id de claims comuns (userId, sub, id).

3) Migrations de analytics nao aplicadas no banco local
- Status verificado via Prisma Migrate Status:
  - 20260313110000_reinspection_approval_rejection_flow (nao aplicada)
  - 20260622000000_add_analytics_tables (nao aplicada)
  - 20260625000000_analytics_link_user_field (nao aplicada)
- Sem essas migrations, a estrutura de analytics (incluindo analyticsUserId) nao esta garantida no banco em uso.

Observacao: no seu relato, a coluna analyticsUserId ja existe fisicamente no banco. Ainda assim, manter historico de migrations alinhado e recomendado para evitar drift de schema entre ambientes.

## 4. Evidencias de codigo verificadas

- Captura do JWT userId e envio para service:
  - src/analytics/analytics.controller.ts
- Fallback seguro de verificacao e extracao de claims (userId/sub/id):
  - src/analytics/analytics.controller.ts
- Normalizacao e decisao por ANALYTICS_LINK_USER_ENABLED:
  - src/analytics/analytics.service.ts
- Persistencia do analyticsUserId no receipt:
  - src/analytics/analytics-ingest.processor.ts
- Campo no schema Prisma:
  - prisma/schema.prisma (model AnalyticsSummaryReceipt, campo analyticsUserId)
- Migration que adiciona a coluna:
  - prisma/migrations/20260625000000_analytics_link_user_field/migration.sql

## 5. Tabelas de analytics: significado, campos e metricas

## 5.1 AnalyticsSummaryReceipt
Significado:
- Recibo tecnico de cada summary recebido e processado.

Campos principais:
- periodStart, periodEnd
- platform, appVersion, runtimeVersion
- installHash, sessionHash
- acceptedScreensCount, acceptedActionsCount, acceptedFormsCount
- discardedItemsCount
- validationStatus
- payloadHash
- analyticsUserId (opcional)

Metricas cobertas:
- Volume de summaries recebidos
- Taxa de descarte parcial por itens fora de allowlist
- Distribuicao por plataforma/versao
- (Opcional controlado) associacao tecnica com usuario autenticado

## 5.2 AnalyticsScreenDaily
Significado:
- Agregado diario de visualizacoes de tela.

Campos principais:
- day, platform, appVersion, screen
- viewCount
- totalTimeMs

Metricas cobertas:
- Telas mais acessadas
- Tempo total por tela
- Tempo medio por visualizacao (derivado: totalTimeMs / viewCount)

## 5.3 AnalyticsActionDaily
Significado:
- Agregado diario de acoes de produto (login, biometria, cupom etc.).

Campos principais:
- day, platform, appVersion, action
- count

Metricas cobertas:
- Frequencia de eventos de negocio por acao
- Funil macro de autenticacao e uso de funcionalidades

## 5.4 AnalyticsFormDaily
Significado:
- Agregado diario de interacoes com formularios.

Campos principais:
- day, platform, appVersion, screen, form
- startedCount, submittedCount, successCount, errorCount

Metricas cobertas:
- Inicio de preenchimento
- Submissoes
- Sucesso e erro por formulario
- Taxa de sucesso/erro (derivadas no dashboard)

## 5.5 AnalyticsSessionDaily
Significado:
- Serie diaria de sessoes unicas e instalacoes unicas por plataforma/versao.

Campos principais:
- day, platform, appVersion
- sessionsCount
- installsCount

Metricas cobertas:
- Engajamento diario (sessoes)
- Base ativa aproximada (instalacoes unicas por dia)

## 5.6 AnalyticsDailyUniqueSession
Significado:
- Tabela auxiliar de deduplicacao diaria de sessao.

Campos principais:
- day, platform, appVersion, sessionHash

Metricas cobertas:
- Nao e tabela de dashboard final.
- Suporta a contagem correta de sessionsCount sem duplicidade.

## 5.7 AnalyticsDailyUniqueInstall
Significado:
- Tabela auxiliar de deduplicacao diaria de instalacao.

Campos principais:
- day, platform, appVersion, installHash

Metricas cobertas:
- Nao e tabela de dashboard final.
- Suporta a contagem correta de installsCount sem duplicidade.

## 6. Testes executados nesta validacao

- Teste unitario do service de analytics:
  - arquivo: src/analytics/analytics.service.spec.ts
  - resultado: 24 testes passando
  - inclui cenarios de ANALYTICS_LINK_USER_ENABLED true/false e normalizacao de userId

## 7. Acoes recomendadas para corrigir o ambiente

1. Aplicar migrations pendentes no banco de desenvolvimento.
2. Confirmar que o app envia Authorization no POST /api/analytics/summaries quando o usuario estiver autenticado.
3. Validar no banco com consulta simples em AnalyticsSummaryReceipt, verificando analyticsUserId nao nulo para requests autenticados.
4. Se necessario, adicionar log temporario no app mobile para confirmar envio do header Authorization no flush.

## 8. Observacao de consistencia documental

O documento original de implementacao enfatiza "sem associacao a usuario" por privacidade, mas o codigo atual possui modo opcional controlado por flag para gravar analyticsUserId em ambiente controlado. Isso deve ser explicitado como excecao operacional para evitar ambiguidade entre especificacao e implementacao atual.
