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

## O que mudou em novembro de 2026

As pendências que este documento listava foram tratadas no plano de arquitetura (fases 0, 4 e 5).
O módulo foi quebrado em casos de uso (`services/reinspection-*.service.ts`), com a regra pura em
`domain/` e as escritas em `repositories/`; `ReinspectionService` ficou como fachada.

**Posse.** As rotas do app (`POST /reinspection`, `POST /:id/photos`, `POST /:id/submit`, `GET/PATCH
/status`, `GET /rejected-photos`, `PATCH /finalizar`, `PATCH /photos/:photoId/resend`) só atendem o dono
do veículo; token ADMIN (painel) é isento. `PATCH /sga/set-revistoria` segue sem posse.

**Transições validadas.** `Reinspection.status` é gravado em um ponto só
(`ReinspectionRepository.transicionar`, `UPDATE ... WHERE status IN (...)`), pela tabela de
`src/reinspection/domain/revistoria-transicoes.ts`:

| De | Para |
|---|---|
| PENDENTE | EM_ANALISE, APROVADA, REPROVADA, FINALIZADA |
| EM_ANALISE | APROVADA, REPROVADA, FINALIZADA |
| REPROVADA | EM_ANALISE, FINALIZADA |
| APROVADA | REPROVADA (foto reprovada depois da aprovação), FINALIZADA |
| FINALIZADA | — (terminal) |

Transição fora da tabela responde 409 `REVISTORIA_TRANSICAO_INVALIDA` (com `statusAtual` e
`statusPretendido`). Três comportamentos antigos deixaram de existir, e cada um é uma linha da tabela se
for preciso voltar atrás:

- reprovar foto de revistoria `FINALIZADA` não a reabre mais (409; a foto não muda);
- aprovar foto de revistoria `APROVADA` ou `FINALIZADA` aprova a foto e **não** rebaixa a revistoria
  para `EM_ANALISE`;
- `PATCH /status` em revistoria `APROVADA` ou `FINALIZADA` responde 409 em vez de rebaixar (só acontece
  se o painel aprovar entre o envio das fotos e essa chamada do app).

**Corridas fechadas.** Aprovar e reprovar foto rodam com a linha da revistoria travada; duas aprovações
simultâneas geram um boleto e um envio; `submit` repetido manda um e-mail só; `create` repetido em até
2 minutos (mesmo veículo e tipo, ainda sem foto) devolve a revistoria já aberta.

**Aprovação repetida.** Responde 200 com `repetida: true` e não refaz os efeitos — exceto quando a
revistoria já estava `APROVADA` e o boleto nunca teve tentativa (`NAO_GERADO`, processo que caiu no
meio): aí os efeitos são retomados.

**Envio à Hinova sob lease.** `hinovaEnvioLeaseAte` é reivindicado antes de qualquer chamada: dois
envios simultâneos não postam a mesma foto. Reenvio manual com outro em curso responde 409
`REVISTORIA_HINOVA_ENVIO_EM_ANDAMENTO`. Sem resposta da Hinova (timeout, conexão derrubada), o erro
gravado avisa que o resultado é indeterminado — as fotos podem ter sido gravadas no SGA; confira antes
de reenviar.

**Campos aditivos nas respostas:** `PATCH /aprovar` → `repetida`, `hinovaEnvio`, `falhas[]`;
`POST /:id/submit` → `notificacao`; `PATCH /photos/:id/resend` → `notificacao`.

## Pendências que continuam

- `FINALIZADA` depende de o app abrir a Home após o veículo voltar a ATIVO.
- Revistorias `PENDENTE` órfãs se acumulam quando o upload falha e o app recomeça.
- Foto gravada na Hinova cuja resposta se perdeu pode ser postada de novo no reenvio (não há consulta
  de fotos do lado deles).
- As rotas por `userVehicleId` atuam na última revistoria do veículo.
