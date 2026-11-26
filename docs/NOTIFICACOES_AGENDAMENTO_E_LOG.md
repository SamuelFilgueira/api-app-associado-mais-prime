# Notificações — disparo agendado e log de quem fez

Implementado em 2026-11-19. Só adiciona: nenhuma rota, campo ou resposta existente mudou.

## Disparo de marketing agendado

`POST /api/notifications/admin/marketing` (perfis MARKETING e ADMIN) ganhou o campo **opcional** `agendarPara` (ISO 8601 com fuso, ex.: `2026-12-01T09:00:00-03:00`).

| | Sem `agendarPara` | Com `agendarPara` |
|---|---|---|
| Comportamento | Envia na hora (igual a antes) | Só agenda |
| Resposta | `{ sentCount, skippedCount }` | `{ agendado: true, id, agendarPara, sentCount: 0, skippedCount: 0 }` |

Regras: mínimo 1 minuto no futuro, máximo 1 ano; fora disso, 400.

- **Fonte da verdade:** `MarketingNotificationAuditLog` (`status = SCHEDULED`, `scheduledFor`). O job atrasado na fila `marketing-agendada` (`MARKETING_AGENDADA_QUEUE`) é só o despertador.
- **Destinatários:** calculados **na hora do envio**, pelo mesmo `NotificationsService.sendMarketingNotification` do disparo imediato (usuário ativo, aceita marketing, com token).
- **Status:** `SCHEDULED → SENDING → SENT | FAILED`; `SCHEDULED → CANCELED`. Disparo imediato continua `REQUESTED → SENT | FAILED`.
- **Tentativa única:** o job não tem retry — reenviar um push em massa duplicaria a campanha.
- **Reinício do servidor** (`MarketingAgendamentoService.reconciliarPendentes`, no boot):
  - agendamento pendente sem job no Redis → job recriado;
  - vencido há até 6 h → enviado ao subir; vencido há mais de 6 h → `FAILED` ("horário perdido"), não envia;
  - `SENDING` parado há mais de 10 min → `FAILED` ("interrompido"), não reenvia.

### Rotas novas (MARKETING e ADMIN)

| Rota | Função |
|---|---|
| `GET /api/notifications/admin/marketing/historico?limit=50` | Log dos disparos (imediatos, agendados e por planilha): quem pediu, quando, status, contagens, quem cancelou. Máx. 200. |
| `PATCH /api/notifications/admin/marketing/agendados/:id/cancelar` | Cancela um agendamento ainda `SCHEDULED`. Já enviado/em envio/cancelado → 409. |
| `GET /api/notifications/admin/popup/historico?limit=50` | Log de inclusão/alteração de pop-up. |

## Log de quem cadastrou e quando

| Ação | Onde fica | Campos |
|---|---|---|
| Disparo de marketing (imediato ou agendado) | `MarketingNotificationAuditLog`, `tipo = MARKETING` | `adminPanelUserId`, `requestedAt`, `normalizedAt` (horário de Brasília), `scheduledFor`, status, contagens |
| Disparo por planilha (situação de cadastro) | mesma tabela, `tipo = SITUACAO_CADASTRO` | idem |
| Cancelamento de agendamento | mesma linha | `canceledAt`, `canceledByAdminPanelUserId` |
| Pop-up criado ou alterado (inclui ativar/desativar) | `NotificationPopupAuditLog` | `acao` (`CRIADO`/`ATUALIZADO`), usuário (id, nome, e-mail), estado gravado, `createdAt` |

Cada registro também sai no log da aplicação (`[MARKETING][AUDIT]`, `[MARKETING][AGENDADO]`, `[POPUP][AUDIT]`). O log do pop-up nunca interrompe o cadastro: falha ao gravar só vai para o log.

## Banco

Migration `20261119120000_push_agendado_e_log_popup`: 4 colunas novas em `MarketingNotificationAuditLog` (`tipo` com default `MARKETING`, `scheduledFor`, `canceledAt`, `canceledByAdminPanelUserId`, todas opcionais), 1 índice e a tabela `NotificationPopupAuditLog`.

```bash
npx prisma migrate deploy
```

## Painel

- **Notificações:** chave "Agendar envio" com data/hora; tabela "Histórico de disparos" com usuário, horário, status e botão "Cancelar" nos agendados.
- **Pop-up:** bloco "Histórico de alterações".
- **Clube de Vantagens:** desativado para todos os perfis por `CLUBE_VANTAGENS_ENABLED = false` em `src/config/features.ts` do painel (menu oculto e rotas `/parceiros-diretos*` redirecionam). Backend intocado.

## O que mudou em novembro de 2026

- **Disparo em massa por lotes.** Marketing (imediato ou agendado) e planilha criam um `PushDisparo`
  com uma `PushEntrega` por destinatário e enfileiram lotes de 100 na fila `push-massa`. A rota responde
  na hora com o que se sabe (`sentCount` = destinatários selecionados) e com `disparoId`, `estado`,
  `totalDestinatarios` e `repetido`. O envio acontece no papel `worker`.
- **Resultado do disparo:** `GET /api/notifications/admin/disparos/:id` (MARKETING e ADMIN) devolve o
  estado, a contagem das entregas (pendentes, enviadas, entregues, recusadas, falhas) e
  `cpfsComFalhaEnvio` (até 1.000). É o que substitui a lista de falhas que a planilha devolvia na
  própria resposta — o painel precisa passar a consultar essa rota.
- **Um disparo por pedido.** Pedido idêntico simultâneo responde 409 `DISPARO_EM_ANDAMENTO`; repetido
  em até 2 minutos devolve o disparo existente (`repetido: true`). As rotas aceitam `Idempotency-Key`.
- **Log.** `MarketingNotificationAuditLog` é fechado na mesma transação que fecha o disparo
  (`SENT` ou `FAILED`, com as contagens reais). Com destinatários e nenhum push aceito, o log fica
  `FAILED` (antes ficava `SENT` com 0).
- **Agendado com retry.** O job reivindica `SCHEDULED → SENDING` e cria o disparo na mesma transação;
  falha transitória usa as 5 tentativas da fila e continua do mesmo disparo. A reconciliação de boot
  virou uma varredura de 1 minuto, que também retoma disparo parado e fecha log órfão.
  **No primeiro deploy**, log `REQUESTED`/`SENDING` antigo, sem disparo e parado há mais de 15 minutos,
  é fechado como `FAILED`.
- **Recibos do Expo** são conferidos 15, 30 e 60 minutos depois; token morto é apagado.
