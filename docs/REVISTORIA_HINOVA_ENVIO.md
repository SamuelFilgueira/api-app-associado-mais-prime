# Revistoria — envio de fotos à Hinova, log persistido e reenvio manual

Implementado em 2026-10-21 após incidente em que fotos de revistorias aprovadas não chegaram à Hinova e não havia rastro em banco.

## O que mudou

### Envio à Hinova sai do `ReinspectionService`
`src/reinspection/services/reinspection-hinova.service.ts` (`ReinspectionHinovaService.enviarFotos`) concentra a chamada `POST {SGA_BASE_URL}/veiculo/foto/cadastrar`:

- envia **só fotos com `sentToHinova = false`** (evita duplicar na Hinova após reaprovação/reenvio de foto reprovada); `forcar = true` inclui as já enviadas;
- lê cada arquivo local individualmente: foto sem arquivo não derruba o lote, recebe `hinovaUltimoErro`;
- `timeout` de 60 s na chamada;
- HTTP ≥ 400, corpo não-array, timeout ou falha de login na Hinova viram `status = FALHA` **sem lançar exceção** (a aprovação não é bloqueada);
- retorno da Hinova (`[{ nome_arquivo, situacao }]`) é casado com as fotos na ordem de envio (nomes repetidos entre lotes não colidem mais);
- toda tentativa grava uma linha em `ReinspectionHinovaEnvio` e atualiza `Reinspection.hinovaEnvioStatus` / `hinovaUltimoEnvioEm`.

`approveByUserVehicleId` continua gravando `APROVADA`, e-mail e boleto; só o trecho de Hinova foi trocado pela chamada ao service novo (origem `APROVACAO`, com o usuário do painel quando disponível).

### Banco (migration `20261021120000_reinspection_hinova_envio`)
- `Reinspection.hinovaEnvioStatus` enum `NAO_ENVIADA | ENVIADA | PARCIAL | FALHA` (default `NAO_ENVIADA`) e `hinovaUltimoEnvioEm`.
- `ReinspectionPhoto.hinovaEnviadaEm`, `hinovaTentativas`, `hinovaUltimoErro`.
- Tabela `ReinspectionHinovaEnvio`: `origem` (`APROVACAO | REENVIO_MANUAL`), `status`, `baseOrigin`, `adminPanelUserId/Email`, totais, `photoIds`, `httpStatus`, `responseBody` (sem binários, truncado), `errorMessage`, `duracaoMs`.

`hinovaEnvioStatus` é um eixo separado de `ReinspectionStatus`; o fluxo de status da revistoria **não mudou**.

### Rotas novas (painel, `AdminPanelRoleGuard` + perfil `REVISTORIA`)
| Rota | Função |
|---|---|
| `GET /api/reinspection/hinova/pendentes` | Revistorias `APROVADA`/`FINALIZADA` com fotos `sentToHinova = false` (chassi, placa, totais, tentativas, último erro). |
| `POST /api/reinspection/:id/hinova/reenviar` | Reenvia as fotos pendentes. Body opcional `{ photoIds?: number[], forcar?: boolean }`. Resposta: `{ envioId, status, hinovaEnvioStatus, totalFotos, totalInseridas, totalFalhas, httpStatus, errorMessage, fotos[] }`. Sem foto pendente retorna `status: null` e `mensagem`. |
| `GET /api/reinspection/:id/hinova/envios` | Histórico de tentativas da revistoria. |
| `GET /api/reinspection/:id` | Detalhe da revistoria (o painel deixava de achar revistorias fora das 100 primeiras da lista). |

Sem job de retry: a Hinova bloqueia token por rajada (`docs/HINOVA_BLOQUEIO_TOKEN_PROTECOES.md`); o reenvio é manual e auditado.

### Guards
- `AdminPanelRoleGuard` passou a comparar `adminRole` do token com `@AdminPanelRoles(...)`. `adminRole = ADMIN` libera tudo; token ADMIN sem `adminRole` (admin legado do app) continua liberado. Antes, qualquer usuário do painel acessava qualquer rota.
- Rotas de painel que estavam só com JWT e agora exigem perfil `REVISTORIA`: `PATCH /reinspection/aprovar`, `PATCH /reinspection/photos/:photoId/approve`, `PATCH /reinspection/photos/:photoId/reprove`.
- Rotas do app ficaram intocadas (contrato e guards): `POST /reinspection`, `POST /:id/photos`, `POST /:id/submit`, `PATCH /status`, `PATCH /finalizar`, `GET /status`, `GET /template`, `GET /rejected-photos`, `PATCH /photos/:photoId/resend`.

### Campos adicionados em respostas existentes (aditivos)
- `GET /reinspection`, `/all`, `/search`: `hinovaEnvioStatus`, `hinovaUltimoEnvioEm`.
- `GET /reinspection/:id/photos`: `hinovaEnviadaEm`, `hinovaTentativas`, `hinovaUltimoErro` por foto.

## Painel (`protecto-admin-suite`)
- Menu **Pendentes Hinova** (`/reinspections/hinova-pendentes`): lista com botão **Reenviar**.
- Detalhe da revistoria: badge `Hinova: ...`, seção **Envio à Hinova (SGA)** com "Reenviar pendentes", "Forçar todas" (confirmação) e histórico de tentativas; cada foto mostra `Hinova ✓/✗`.
- `getById` passou a usar `GET /reinspection/:id`.

## Aplicar localmente
```bash
# API
npx prisma migrate dev            # aplica 20261021120000_reinspection_hinova_envio (sem reset)
# se o banco local tiver drift: npx prisma migrate diff ... | npx prisma db execute --stdin && npx prisma migrate resolve --applied 20261021120000_reinspection_hinova_envio
npx prisma generate
npm run verify                    # typecheck + jest + build
npm run start:dev

# Painel
npm run build && npm run dev
```

## Pendências conhecidas (não feitas por decisão de não alterar contratos/fluxo)
- Rotas do app não validam se o `userVehicle` pertence ao usuário do JWT (IDOR); idem `PATCH /sga/set-revistoria`.
- `submit` não muda o status (o app chama `PATCH /status` em seguida); `create` permite nova revistoria com outra aberta; ações por `userVehicleId` atuam na última revistoria do veículo.
- Transições de status não são validadas (`aprovar` aceita `PENDENTE`, `approvePhoto` rebaixa `APROVADA` para `EM_ANALISE` etc.).
- `FINALIZADA` depende de o app abrir a Home após o veículo voltar a ATIVO.
