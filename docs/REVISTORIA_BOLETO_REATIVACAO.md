# Revistoria — boleto de reativação com retry e adoção de boleto do SGA

Implementado em 2026-10-22, validado com cobrança/revistoria. Complementa `docs/REVISTORIA_HINOVA_ENVIO.md`.

## Problema
Na aprovação da revistoria o boleto era criado dentro da mesma requisição e qualquer erro (instabilidade da Hinova, token bloqueado, placa inexistente) virava só `logger.error`. O e-mail "aprovada e boleto gerado" saía **antes** da criação, com texto fixo, então a cobrança acreditava que o boleto existia.

## Fluxo atual (`PATCH /reinspection/aprovar`)
1. Grava `APROVADA`.
2. Envia fotos à Hinova (`ReinspectionHinovaService`, log em `ReinspectionHinovaEnvio`).
3. `BoletoReativacaoService.processar(origem = APROVACAO)`:
   - **Lock otimista** por `boletoTentativas` (duas tentativas simultâneas não cadastram dois boletos).
   - Consulta `POST /listar/boleto-associado-veiculo` (`codigo_veiculo`, vencimento original de hoje a hoje+45d). Se houver boleto **tipo 2 (reativação), situação 2 (ABERTO)** e vencimento ≥ hoje, **adota**: grava `ReinspectionPayment`, agenda o poller de pagamento, envia Suri com o link e o e-mail de aprovação. Boleto de mensalidade (outro tipo) nunca é adotado. O SGA não expõe data de criação; "criado hoje" é aproximado por tipo + situação + vencimento futuro.
   - Senão, cadastra pela API (`SgaService.criarBoletoReativacao`: associado → produtos → `boleto/cadastrar` → `ReinspectionPayment` → situação 20 → poller → Suri) e envia o e-mail de aprovação.
   - **Instabilidade** do SGA (401/403/408/429/5xx, timeout, rede, falha de login): `boletoStatus = PENDENTE_RETRY`, job na fila `boleto-reativacao-retry` para daqui a 5 min. Repete até 24 h da primeira falha (`boletoRetryInicioEm`); depois vira `FALHA`.
   - **Erro definitivo** (CPF/placa ausentes, 4xx de negócio como placa inexistente no SGA): `boletoStatus = FALHA` na hora, sem retry.
   - `FALHA` dispara o e-mail "Revistoria Aprovada - boleto NÃO gerado automaticamente" (`sendRevistoriaAprovadaSemBoletoEmail`) para a cobrança gerar à mão.
4. Resposta da rota ganha o campo aditivo `boleto: { status, nossoNumero, tentativas, proximaTentativaEm, erro }`.

O e-mail de aprovação (`sendRevistoriaAprovadaEmail`) só sai quando o boleto existe (gerado ou adotado), seja na aprovação, no retry ou na geração manual.

### Retry (`BoletoReativacaoRetryProcessor`)
- Job de tentativa única (`jobId = boleto-reativacao-retry-<reinspectionId>-<tentativa>`); o próprio service agenda o próximo. Sem `attempts`/`backoff` do BullMQ.
- No boot, `reconciliarPendentes()` garante job para toda revistoria `PENDENTE_RETRY` (reinício entre a falha e o reagendamento, Redis limpo). `jobId` determinístico evita duplicar.
- Tentativa **manual** reinicia a janela de 24 h.

### Banco (migration `20261022120000_reinspection_boleto_retry`)
- `Reinspection`: `boletoStatus` (`NAO_GERADO | GERADO | PENDENTE_RETRY | FALHA`), `boletoTentativas`, `boletoUltimaTentativaEm`, `boletoProximaTentativaEm`, `boletoRetryInicioEm`, `boletoUltimoErro`, `boletoNossoNumero`, `boletoOrigem` (`CRIADO_APP | ADOTADO_SGA`).
- `ReinspectionPayment.reinspectionId` (nulo nos registros antigos).
- Revistorias aprovadas antes desta versão ficam `NAO_GERADO` (sem backfill) e **nunca têm boleto criado retroativamente**: só a origem `APROVACAO` inicia o processo; retry (`reconciliarPendentes` consulta apenas `PENDENTE_RETRY`) e geração manual recusam `NAO_GERADO` com `pulado = true`. A tela de pendentes lista só `PENDENTE_RETRY` e `FALHA`.

### Rotas novas (painel, perfis REVISTORIA e COBRANCA)
| Rota | Função |
|---|---|
| `GET /api/reinspection/boleto/pendentes` | Revistorias aprovadas com boleto em retry ou falha. |
| `POST /api/reinspection/:id/boleto/gerar` | Tenta agora (mesma lógica do retry; adota ou cadastra). Só `APROVADA`; se já `GERADO`, responde `pulado = true`. |

### Envs (opcionais, defaults em `sga/config/boleto-reativacao-retry.config.ts`)
`BOLETO_REATIVACAO_RETRY_INTERVALO_MIN=5`, `BOLETO_REATIVACAO_RETRY_MAX_HORAS=24`, `BOLETO_REATIVACAO_JANELA_VENCIMENTO_DIAS=45`.

### Painel
- Menu **Boletos pendentes** (`/reinspections/boletos-pendentes`) com "Gerar agora".
- Detalhe da revistoria aprovada: card "Boleto de reativação" com status, nosso número/origem, próxima tentativa, último erro e botão "Gerar boleto agora".

## Contratos
Nenhuma rota, parâmetro ou campo existente mudou. Rotas do app intocadas. `criarBoletoReativacao` ganhou um 4º parâmetro opcional e passou a retornar os dados do boleto (antes `void`); o único chamador é o `BoletoReativacaoService`.

## Riscos residuais
- Hinova pode cadastrar o boleto e não responder (timeout após o insert). A tentativa seguinte adota o boleto pela consulta, desde que ele venha com `codigo_tipo_boleto = 2` e `codigo_situacao_boleto = 2`. Se a Hinova devolver esses campos vazios, a API cadastra outro.
- `codigoVeiculo` nulo na revistoria (app não enviou): a consulta de adoção é pulada e vai direto ao cadastro.
- Suri continua tentativa única; falha fica só no log (`Falha ao enviar notificação Suri`).

## Aplicar
```bash
npx prisma migrate deploy   # ou migrate dev localmente
npx prisma generate
npm run verify
```
