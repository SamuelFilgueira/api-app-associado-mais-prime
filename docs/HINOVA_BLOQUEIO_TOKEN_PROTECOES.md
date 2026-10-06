# Proteções contra bloqueio de token da Hinova (SGA)

**Desde:** 2026-10-06

## 1. Contexto

Resposta da Hinova ao chamado (06/10/2026): **não há limite de requisições**.
O bloqueio do token é uma medida de segurança **automática**, disparada por
"excesso de requisições ou comportamento agressivo ao recurso em um período
muito curto de tempo", e o desbloqueio também é automático, cerca de **1 hora**
depois. Ou seja: o gatilho não é o volume diário do app (tráfego humano,
espalhado), e sim **padrões de máquina** — rajadas, repetição do mesmo recurso
em alta frequência e insistência contra um token já recusado.

## 2. O que no código produzia esse padrão

| # | Mecanismo | Onde | Padrão gerado |
|---|---|---|---|
| 1 | **Poller do boleto de reativação** (revistoria): repeatable BullMQ `every: 120_000` **sem fim**, só removido quando o boleto era pago. Sondava `POST /processa-pdf/boleto` (gera PDF) e, sem status, ainda `POST /listar/boleto-associado-veiculo`. | `sga.service.ts` (`criarBoletoReativacao`) + `boleto-verificacao.processor.ts` | 720–1440 chamadas/dia **por boleto não pago, para sempre**, acumulando a cada revistoria aprovada. O BullMQ alinha todos os `every` ao relógio: **todos os pollers disparavam no mesmo instante**, em rajada, a cada 2 min. É o retrato de "comportamento agressivo ao recurso". |
| 2 | **Tempestade de login durante um bloqueio**: ao falhar o login (token bloqueado, 5xx, rede), nada impedia a próxima requisição de tentar logar de novo. | `sga-auth.service.ts` | Com o app em uso, cada requisição → novo `POST /usuario/autenticar` (× nº de tokens de base). Dezenas de logins/min contra um token que a Hinova já recusou — **prolonga o próprio bloqueio** e pode ser lido como novo "excesso". |
| 3 | **Varredura da rotina de boletos queimando o token reserva**: o failover de token de base (22/09) vale para qualquer requisição; se a Hinova bloqueava o token 1 no meio da paginação, a rotina **continuava a extração com o token 2** — e o bloqueava também. | `sga-boleto-periodo.client.ts` | Os dois tokens da base bloqueados ao mesmo tempo → **app inteiro sem SGA por ~1h**. |

## 3. O que mudou

| Proteção | Arquivo | Efeito |
|---|---|---|
| **Cadência por idade do boleto** no poller: primeiras 24h a cada 2 min (igual a antes); de 1 a 7 dias a cada 10 min; depois a cada 60 min. Decidido pelo banco (`ReinspectionPayment.updatedAt`), sem chamar o SGA. | `sga/config/boleto-verificacao.config.ts`, `boleto-verificacao.processor.ts` | Um boleto de 10 dias cai de 720 para 24 consultas/dia. |
| **Idade máxima** (`BOLETO_VERIFICACAO_MAX_DIAS`, default 30): `endDate` no repeatable novo + checagem no processor para os antigos + **limpeza no boot** dos pollers já expirados. | idem + `sga.service.ts` | Pollers deixam de ser eternos; os acumulados em produção são encerrados no próximo deploy. |
| **Encerra em CANCELADO (3) / EXCLUÍDO (999)**: boleto que nunca mais será pago não é mais sondado. | `boleto-verificacao.processor.ts` | Menos pollers vivos. |
| **Espaçamento mínimo** entre sondagens consecutivas do poller ao SGA (`BOLETO_VERIFICACAO_ESPACAMENTO_MS`, default 1500). | `boleto-verificacao.processor.ts` | Os disparos alinhados pelo BullMQ deixam de sair em rajada. |
| **Pausa de login após falha** (`SgaAuthService`): 15 s após qualquer falha, **60 s quando todos os tokens de base estão bloqueados**. Nesse intervalo as requisições falham na hora, **sem chamar a Hinova**; um login bem-sucedido limpa a pausa. Dedupe em voo mantido. | `sga-auth.service.ts` | Durante um bloqueio: no máximo 1 sondagem de login por minuto por base, em vez de uma por requisição do app. |
| **`failoverTokenBase: false` na varredura** da rotina de boletos. | `sga-auth.service.ts` (`SgaRequestOptions`), `sga-boleto-periodo.client.ts` | Se o token ativo for bloqueado no meio das páginas, a rotina falha (e tenta de novo no próximo agendamento), mas **o token reserva fica livre para o app**. |

## 4. O que NÃO mudou (contrato com o app)

- Rotas, payloads e respostas do SGA ao app são as mesmas. Nenhum cache de resposta foi adicionado.
- Falhas de autenticação continuam chegando ao chamador como antes (`Error` com mensagem `Falha ao autenticar no SGA para base …`); durante a pausa elas apenas chegam mais rápido.
- Failover de token de base para o tráfego do app continua igual (403 de bloqueio → troca de token → repete uma vez).
- Reativação do veículo após pagamento: nas primeiras 24h do boleto o tempo é o mesmo (até 2 min). Depois, até 10 min (1–7 dias) ou até 60 min (> 7 dias). Após `MAX_DIAS`, o boleto não é mais verificado automaticamente.
- A rotina de notificação de boletos mantém pausa entre páginas e janela; só deixa de usar o token reserva.

## 5. Variáveis de ambiente (todas opcionais, com default)

| Variável | Default | Faixa |
|---|---|---|
| `BOLETO_VERIFICACAO_MAX_DIAS` | `30` | 1–365 |
| `BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN` | `10` | 2–1440 |
| `BOLETO_VERIFICACAO_INTERVALO_APOS_7D_MIN` | `60` | 2–1440 |
| `BOLETO_VERIFICACAO_ESPACAMENTO_MS` | `1500` | 0–60000 |

Config lida no boot. Os cooldowns de login (15 s / 60 s) são constantes em `sga-auth.service.ts`.

## 6. Como verificar em produção

```bash
# Pollers de boleto ativos no Redis (antes/depois do deploy)
redis-cli ZCARD bull:boleto-verificacao:repeat
redis-cli ZRANGE bull:boleto-verificacao:repeat 0 -1

# Limpeza no boot e encerramentos
grep -E "Pollers de boleto|encerrado no boot|Verificação encerrada" <log da api>

# Pausa de login e bloqueios da Hinova
grep -E "login no SGA em pausa|BLOQUEADO pela Hinova" <log da api>

# Padrão de tráfego por endpoint no Nginx (rajadas por minuto)
awk '{print substr($4,2,17), $7}' access.log | grep "/api/" | sort | uniq -c | sort -rn | head
```

## 7. Alavancas só de env (sem deploy), se o bloqueio persistir

- `BOLETO_NOTIFICACAO_HORARIO` de madrugada: se a varredura bloquear um token, o desbloqueio (~1h) acontece antes do pico de uso do app.
- `BOLETO_NOTIFICACAO_PAUSA_ENTRE_PAGINAS_MS` maior (até 300000) e/ou `BOLETO_NOTIFICACAO_D20_ALCANCE` menor (menos registros por varredura).
- `BOLETO_NOTIFICACAO_ENABLED=false` por alguns dias isola se a rotina ainda é o gatilho.
