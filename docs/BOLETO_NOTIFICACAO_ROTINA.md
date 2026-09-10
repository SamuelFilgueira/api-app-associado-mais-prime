# Régua de Notificações Push de Boletos (SGA) — v2

> **Atualizado:** 2026-09-10 · **Fonte da regra:** documento do gestor "Régua de notificações push — vencimento do boleto mensal", versão 10/09/2026 · **Módulo:** `src/boleto-notificacao/`

Rotina agendada que roda **todo dia às 11:00** (America/Sao_Paulo, configurável) e dispara push (Expo) nas seis etapas da régua de cobrança, consultando os boletos **ABERTOS** no SGA por **vencimento efetivo**.

## 1. Regras implementadas

### Âncora: vencimento efetivo (D)

A régua define D = vencimento efetivo (se a data original cai em sábado/domingo/feriado, D = próximo dia útil, incluindo feriados locais do associado). A implementação usa o **`data_vencimento` do SGA**, que já vem prorrogado pelo próprio sistema de cobrança — assim os calendários de feriado (inclusive estaduais/municipais) ficam a cargo do SGA/banco, sem calendário próprio no backend. O `data_vencimento_original` não é mais usado como âncora.

Consequência: **não existe mais "dia fixo de gatilho"** — toda etapa é consultada todos os dias, porque D pode cair em qualquer dia útil.

### Etapas (enum `BoletoNotificacaoTipo`)

| Etapa | Janela consultada (data_vencimento) | Condição | Título |
|---|---|---|---|
| `DM5` (D-5) | hoje+1 até hoje+5 | boleto gerado e ABERTO | Seu boleto de {mes} já está no app |
| `D0` | hoje | ABERTO | Seu boleto vence hoje |
| `D1` (D+1) | hoje−1 | ABERTO | Lembrete rápido sobre seu boleto |
| `D5` (D+5) | hoje−5 | ABERTO | Hoje é o último dia para manter sua proteção |
| `D6` (D+6) | hoje−6 | ABERTO + contrato suspenso* | Seu veículo está sem proteção |
| `D20` (D+20) | hoje−20 | ABERTO + contrato suspenso*; encerra a régua | Último dia para reativar sem nova vistoria |

- **DM5 em janela**: consultar hoje+1..hoje+5 todos os dias implementa "se o boleto for gerado depois de D-5, disparar quando aparecer (até D-1); se gerado em D ou depois, pular" — a idempotência garante um único envio por associado × vencimento.
- **Pagamento cancela a régua**: cada etapa consulta `codigo_situacao_boleto = 2` (ABERTO) na hora do envio; boleto BAIXADO/CANCELADO/EXCLUÍDO sai automaticamente. Limitação conhecida: "aguardando compensação" não é um status distinto no SGA — enquanto a baixa não é registrada, o boleto ainda conta como ABERTO.
- ***Contrato suspenso** (D6/D20): filtro opcional por `situacao_veiculo` dos veículos do boleto, via `BOLETO_NOTIFICACAO_SITUACOES_SUSPENSO` (ex.: `INADIMPLENTE,INADIMPLENTE +90`). Vazio = sem filtro extra (default) — **validar com o gestor quais situações do SGA caracterizam "suspenso"**.
- **Tipo de boleto**: `BOLETO_NOTIFICACAO_CODIGOS_TIPO_BOLETO` (ex.: `1,5` = MENSALIDADE, FECHAMENTO) restringe a régua ao boleto mensal; vazio = todos (default) — **decidir com o gestor** (avulsos/quitações entram?).

### Mensagens e tokens

Textos default = textos oficiais do PDF (em `DEFAULT_MENSAGENS`, `config/boleto-notificacao.config.ts`); sobrescreva por env `BOLETO_NOTIFICACAO_MSG_<ETAPA>_{TITULO,CORPO}`. Tokens disponíveis em título e corpo:

| Token | Valor | Exemplo |
|---|---|---|
| `{nome}` | primeiro nome do associado (SGA), capitalizado | Kaio |
| `{placa}` | placa do 1º veículo do boleto (fallback "seu veículo") | ABC1D23 |
| `{mes}` | competência por extenso, de `mes_referente` | Setembro |
| `{data}` | D em DD/MM | 10/09 |
| `{vencimento}` | D em dd/mm/yyyy (legado) | 10/09/2026 |
| `{quantidade}` | nº de boletos do associado nesse vencimento | 2 |

### Demais regras (inalteradas da v1)

1 push por **associado × vencimento** (N boletos agregados; `quantidadeBoletos` no log); casamento por CPF/CNPJ normalizado com `user.cpf` (ativo, tenant compatível, token válido); idempotência pela unique `(tenant, codigoAssociado, dataVencimentoOriginal*, tipoMensagem)`; envio em lotes de 100; deep-link `internal_route → financeiro`; histórico no sino do app; receipts após ~15 min com invalidação de token `DeviceNotRegistered`; métricas por execução (coberturas de elegíveis e entrega). Falha em uma etapa não interrompe as demais.

\* A coluna `dataVencimentoOriginal` (banco) passou a armazenar o **vencimento efetivo** — o nome foi mantido para evitar migration destrutiva.

## 2. Configuração (env — todas com default)

| Env | Default | Descrição |
|---|---|---|
| `BOLETO_NOTIFICACAO_ENABLED` | `false` | Liga o cron diário; execução manual funciona sempre |
| `BOLETO_NOTIFICACAO_HORARIO` | `11:00` | HH:mm America/Sao_Paulo |
| `BOLETO_NOTIFICACAO_OFFSET_{DM5,D1,D5,D6,D20}` | `5,1,5,6,20` | Dias corridos (DM5 = tamanho da janela pré-vencimento) |
| `BOLETO_NOTIFICACAO_MSG_<ETAPA>_{TITULO,CORPO}` | textos da régua | `<ETAPA>` ∈ DM5, D0, D1, D5, D6, D20 |
| `BOLETO_NOTIFICACAO_CODIGOS_TIPO_BOLETO` | vazio (todos) | ex.: `1,5` |
| `BOLETO_NOTIFICACAO_SITUACOES_SUSPENSO` | vazio (sem filtro) | ex.: `INADIMPLENTE,INADIMPLENTE +90` |
| `BOLETO_NOTIFICACAO_QTD_POR_PAGINA` / `_RECEIPTS_DELAY_MIN` / `_TENANTS` / `_SGA_MOCK_FILE` | `500` / `15` / todas / — | como na v1 |

Config lida no boot — alterou env, reinicie a API. Removidas da v1: `DIAS_VENCIMENTO` e `FALLBACK_MES_CURTO` (dias fixos não existem mais; fevereiro é resolvido pelo próprio vencimento efetivo).

## 3. Endpoints admin e migration

Endpoints inalterados (`/api/boleto-notificacao/admin/*`, role ADMIN). Mudanças de payload: `GET /config` não traz mais `diasVencimento`/`fallbackMesCurto`/`diasEfetivos*` e `offsets`/`mensagens` agora têm as 6 etapas; `simular-datas` retorna a **janela** por etapa (DM5 = intervalo) com `gatilho` sempre `true`; `POST /executar` aceita `tipos` ∈ {DM5, D0, D1, D5, D6, D20}; dry-run agora inclui `titulo`/`corpo`/`vencimento` renderizados na `amostraDestinatarios`.

Migration: `20260910120000_regua_boleto_notificacao_v2` (amplia o enum `tipoMensagem`). Produção: `npx prisma migrate deploy`.

**Painel (protecto-admin-suite)** — ajustes necessários: `BOLETO_NOTIFICACao_TIPOS`/labels com as 6 etapas em `types/boletoNotificacao.ts` e `pages/BoletoNotificacao.tsx`; na aba "Agendamento e regras", remover `diasVencimento`/`diasEfetivosFevereiro`/`fallbackMesCurto` (não existem mais na resposta — hoje quebrariam a tela) e exibir os novos offsets/mensagens.

## 4. Teste local / homologação

1. Dry-run com mock: `BOLETO_NOTIFICACAO_SGA_MOCK_FILE=test/fixtures/sga-boleto-kaio.mock.json` (boleto MENSALIDADE ABERTO, venc. efetivo 10/09/2026, CPF de teste) → painel/`POST /executar` com `{"dataReferencia":"10/09/2026","tipos":["D0"],"dryRun":true,"sync":true}` — a amostra mostra o título/corpo renderizados.
2. Envio real com mock (push no celular): mesmo comando sem `dryRun`.
3. Homologação contra o SGA real: dry-run sem mock num dia com vencimentos e conferir volume/paginação (`quantidade_por_pagina`, aviso de duplicados) e os contadores `semUsuario`/`semToken`.
4. `npx jest src/boleto-notificacao` — 23 testes cobrem janelas, textos oficiais, tokens, filtros de tipo/suspenso, idempotência e receipts.

## 5. Pendências a validar com gestor/Hinova

1. Quais `situacao_veiculo` caracterizam **contrato suspenso** (D6/D20) — hoje sem filtro extra por default.
2. Quais `codigo_tipo_boleto` entram na régua (só mensalidade/fechamento?) — hoje todos.
3. "Aguardando compensação" não existe como status no SGA — a régua só para quando a baixa é registrada.
4. Critério de parada da paginação com >500 registros ainda não validado empiricamente no SGA real.
5. Rate limit da Hinova (throttle não implementado).
