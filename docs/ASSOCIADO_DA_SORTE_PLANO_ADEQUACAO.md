# Associado da Sorte — plano de adequação à visão do marketing

Base: [`ASSOCIADO_DA_SORTE_REUNIAO_MARKETING.md`](./ASSOCIADO_DA_SORTE_REUNIAO_MARKETING.md)
(requisitos da reunião de 13/11/2026) e o piloto já implementado
([`ASSOCIADO_DA_SORTE.md`](./ASSOCIADO_DA_SORTE.md)): backend `src/associado-sorte`, painel
`/home/samuel/Documentos/AdminSorte`, app `AppAssociado` na branch `feat/associado-da-sorte`.

Meta: **MVP até quarta, 18/11/2026**, conforme combinado na reunião.

## 1. O que muda, em resumo

| Tema | Piloto atual | Visão do marketing | Decisão |
|---|---|---|---|
| Quem participa | Todos os associados da base com a promoção ativa | Só inscritos no produto "Associado da Sorte" do SGA; os demais veem um convite | **Novo**: elegibilidade por produto SGA |
| Raspadinha | 1 por dia, créditos sorteados por faixas de probabilidade | Raspa para ver se ganhou um **voucher** (120 / 200 / 150) que sai num **horário pré-programado** | **Reescrever** o núcleo da raspadinha |
| Agenda de prêmios | Rodadas criadas e editadas livremente | Cronograma do ano importado de planilha, **travado** no início, auditável | **Novo**: campanha + momentos premiados |
| Gasto de créditos | Rodadas de SORTEIO, CORRIDA e RESGATE (vitrine) | **Loja da Sorte**: catálogo permanente, compra direta com créditos | **Adaptar** a vitrine para loja |
| Sorteio e corrida com créditos | Existem | Não fazem parte da visão (carro e motos: a definir) | **Ocultar**, sem apagar código |
| Check-in e marcos | Existem como alternativa à raspadinha | Não comentado | **Ocultar** até resposta |
| Estoque, ganhadores, WhatsApp, extrato | Existem | Mantidos | **Reaproveitar** |
| Tentativas que falharam | Só aparecem nos logs | Extrato do associado mostra o que tentou e por que não conseguiu | **Novo**: registro de tentativas |
| Lembrete para raspar | Só lembrete de rodada ("Avise-me") | Push lembrando de raspar | **Novo**: lembrete em lote para inscritos |

O que **continua valendo** sem mudança: carteira e lançamentos (`SorteCreditosService.lancar` como
única forma de mexer no saldo), transação com `SELECT ... FOR UPDATE`, controle de estoque com
movimentos, fluxo de entrega do ganhador (AGUARDANDO_CONTATO → EM_CONTATO → ENTREGUE), links de
WhatsApp, upload de foto de prêmio, limite de requisições no Redis, permissão MARKETING no painel.

## 2. Decisões (respondidas em 13/11/2026)

As respostas abaixo substituem os padrões provisórios desta seção. O prompt de implementação que as
consolida é [`ASSOCIADO_DA_SORTE_V2_PROMPT.md`](./ASSOCIADO_DA_SORTE_V2_PROMPT.md); em caso de
divergência com o restante deste plano, vale o prompt.

| Pergunta | Decisão |
|---|---|
| Bases | **Só MAIS_PRIME**. RS fica fora do projeto |
| Limite de raspadas | Configurável no painel: `raspadasPorDia` e `intervaloMinimoMinutos`. Janela = **dia do calendário** em Brasília; o que não foi usado **não acumula**; histórico de raspadas guardado |
| Mais de um voucher | Sim, com `carenciaDias` configurável |
| Momento não ganho | **Não expira**: fica disponível até alguém ganhar |
| Inscrição no SGA | Produto `codigo_produto` **3677**, descrição **"ASSOCIADO DA SORTE"**, `situacao` ATIVO. Dois veículos = **um** participante |
| Créditos | **Não expiram** |
| Convite (não inscrito) | Tocar na aba "Loja da Sorte" abre wa.me com "Olá, sou associado da Mais Prime e gostaria de saber sobre a promoção do associado da sorte" |
| Planilha | Colunas iniciais `data`, `hora`, `creditos`, `descricao` (formato final ainda pode mudar) |
| Aviso de retirada | Área de **Notificações** no painel + e-mail para `marketing@teste.com.br` + campo opcional de wa.me do marketing (número separado do convite) |
| Lembrete de raspar | Push **programático**, conforme as raspadas liberadas do associado no dia |
| Check-in e marcos | Mantidos como **jornada opcional**, ligada pelo marketing no painel |
| Carro e motos | Fora do escopo; o módulo de SORTEIO fica guardado |

## 3. Modelo de dados (nova migration `associado_sorte_v2`)

Sem `migrate reset`: os dados atuais são só de demonstração, mas a migration nova **altera**
o que existe em vez de recriar. Mesmas regras de antes: conferir `DATABASE_URL` antes de rodar.

### Novos modelos

- **`SorteCampanha`**: `id`, `baseOrigin`, `nome`, `inicio`, `fim`, `estado`
  (`RASCUNHO` → `PUBLICADA` → `ENCERRADA`), `publicadaEm`, `publicadaPorId/Nome`,
  `hashCronograma` (SHA-256 do cronograma no momento da publicação), `regulamento`.
  Uma campanha publicada por base de cada vez.
- **`SorteMomentoPremiado`**: `id`, `campanhaId`, `liberaEm`, `creditos`, `descricao`,
  `userId?`, `ganhoEm?`, `raspadaId?`. Índice em `(campanhaId, userId, liberaEm)` para achar
  "o mais antigo já liberado e não ganho". Depois da publicação, **nenhuma rota altera `liberaEm`,
  `creditos` nem apaga momento** (trava no serviço e no repositório).
- **`SorteRaspada`** (substitui `SorteColetaDiaria`): `id`, `userId`, `baseOrigin`, `campanhaId`,
  `dia`, `criadoEm`, `resultado` (`GANHOU` | `NAO_GANHOU`), `momentoId?`, `creditos`.
  Sem `@@unique([userId, dia])`: o limite diário vira contagem dentro da transação.
- **`SorteInscricao`**: `userId` (PK), `baseOrigin`, `inscrito`, `fonte` (`SGA` | `IMPORTACAO` |
  `MANUAL`), `codigosVeiculo`, `verificadoEm`. Cache da consulta ao SGA.
- **`SorteTentativa`**: `id`, `userId`, `baseOrigin`, `acao` (`RASPAR` | `COMPRAR` | …),
  `codigo` (o mesmo código de erro da API, ex.: `CREDITOS_INSUFICIENTES`, `ESGOTADO`,
  `NAO_INSCRITO`), `contexto` (JSON curto: produto, saldo), `criadoEm`. Gravada fora da transação,
  sem CPF nem telefone.

### Alterações

- **`SortePremio`** vira item da loja: `+ tipo` (`FISICO` | `SERVICO_MAIS_PRIME` | `CUPOM_PARCEIRO`),
  `+ custoCreditos`, `+ naLoja` (bool), `+ limitePorAssociado` (0 = sem limite),
  `+ instrucoesRetirada` (texto mostrado ao associado após a compra), `+ ordem`.
- **`SorteGanhador`** passa a representar também a **compra na loja**: `rodadaId` opcional,
  `origem` ganha o valor `LOJA`, o `@@unique([rodadaId, userId])` sai e o limite por associado
  passa a ser checado na transação (com trava da carteira, que já serializa o mesmo usuário).
- **`SorteConfig`**: `+ produtoSgaCodigos` (JSON por base), `+ raspadasPorDia`,
  `+ lembreteHorario` (ex.: `"10:00"`), `+ conviteTexto`, `+ conviteLink`.
  `faixasRaspadinha`, `creditosCheckin` e `marcosSequencia` ficam no banco, sem uso no MVP.
- **`SorteLancamentoTipo`**: `+ VOUCHER_RASPADINHA`, `+ COMPRA_LOJA`.

## 4. Backend (`src/associado-sorte`)

### 4.1 Elegibilidade — `SorteInscricaoService` (novo)

- `estaInscrito(userId, baseOrigin)`: lê `SorteInscricao`; se `verificadoEm` tem mais de 6 h (ou
  não existe), consulta o SGA: veículos do associado → `produto-vinculado-veiculo/listar/<veículo>`
  → procura o código configurado com `situacao` ativa. Consumir `BeneficiosVeiculoService` pelo
  módulo exportado (`imports: [BeneficiosVeiculoModule]`), sem chamar axios direto.
- Falha do SGA: usa o último valor em cache; se nunca verificou, responde "não inscrito" com
  `motivo: 'VERIFICACAO_INDISPONIVEL'` para o app mostrar "tente mais tarde" em vez do convite.
- Painel: `POST /admin/associado-sorte/inscricoes/importar` (CSV do relatório do SGA com CPFs)
  e `POST .../inscricoes/:userId` (marcar à mão), para não depender só da API do SGA.
- `SorteAcessoService` passa a exigir inscrição em todas as rotas do app, exceto `resumo`
  (que devolve `inscrito: false` + convite) e `regulamento`.

### 4.2 Campanha e cronograma — `SorteCampanhaService` (novo)

- CRUD de campanha em RASCUNHO; importação do cronograma por **CSV** (`data;hora;creditos;descricao`),
  com pré-visualização e validação (datas dentro da campanha, créditos > 0, sem duplicidade).
- `publicar`: grava `hashCronograma`, muda para PUBLICADA e **trava**: a partir daí, rotas de
  edição de momentos respondem 409 `CAMPANHA_TRAVADA`. Produtos da loja continuam editáveis.
- `exportarAuditoria`: CSV com cronograma, hash, ganhador de cada momento (nome + CPF mascarado),
  horário da raspada vencedora e o log de raspadas do período.

### 4.3 Raspadinha — reescrever `SorteColetaDiariaService` como `SorteRaspadinhaService`

Transação (READ COMMITTED, mesmo `SorteUnidadeTrabalho`), ordem de travas **momento → carteira**:

1. Fora da transação: inscrição, limite de requisições, campanha publicada e dentro do período.
2. Trava a carteira e conta as raspadas do dia → `LIMITE_DIARIO` se passou de `raspadasPorDia`.
3. Carência: se ganhou há menos de `carenciaDias`, registra `NAO_GANHOU` sem olhar momentos.
4. `SELECT ... FROM SorteMomentoPremiado WHERE campanhaId = ? AND userId IS NULL AND liberaEm <= NOW()
   ORDER BY liberaEm LIMIT 1 FOR UPDATE SKIP LOCKED` (MariaDB ≥ 10.6 tem `SKIP LOCKED`; conferir a
   versão de produção. Sem ele, `FOR UPDATE` simples também é correto, só serializa mais).
5. Achou: grava `userId`, `ganhoEm`, credita via `SorteCreditosService.lancar` (`VOUCHER_RASPADINHA`)
   e cria `SorteRaspada(GANHOU)`. Não achou: `SorteRaspada(NAO_GANHOU)`.
6. Resposta: `{ resultado, creditos, saldo, proximaRaspadaEm }`. O app só anima; o resultado vem
   pronto do servidor antes da raspagem, como hoje.

Testes obrigatórios: momento não sai antes de `liberaEm` (relógio fixo 14:59:59 vs 15:00:00);
dois associados raspando ao mesmo tempo com um momento liberado → exatamente um ganha; momento
de ontem não ganho sai hoje; limite diário; carência; campanha travada não aceita edição.

### 4.4 Loja da Sorte — adaptar `SorteResgateService`

- `GET /associado-sorte/loja` (produtos `naLoja`, ativos, com estoque e custo) e
  `POST /associado-sorte/loja/:premioId/comprar`. A lógica de transação do resgate atual
  (trava prêmio → carteira, débito, estoque, ganhador, push) é a mesma, sem rodada.
- Checagem de `limitePorAssociado` dentro da transação.
- Resposta com `instrucoesRetirada` e o código do pedido; o pedido aparece em "Meus prêmios".
- **Aviso à equipe** a cada compra: indicador "novas retiradas" no painel (contagem de
  AGUARDANDO_CONTATO) já no MVP; e-mail via `MailService` só se o marketing pedir (pergunta 11).

### 4.5 O que sai do caminho

- Rodadas (SORTEIO / CORRIDA / RESGATE): rotas do app e do painel ficam atrás de uma flag
  `SorteConfig.rodadasHabilitadas` (padrão `false`); o job continua apurando o que existir.
  Código, testes e tabelas ficam, porque o sorteio do carro e das motos pode precisar deles.
- Check-in e marcos de sequência: fora do resumo e do painel enquanto não houver resposta.

### 4.6 Registro de tentativas e lembrete

- `SorteTentativaService.registrar(...)` chamado no `catch` de raspar e comprar (e no 403 de não
  inscrito), em `void ... .catch(log)` para nunca derrubar a resposta.
- Lembrete diário de raspar: o `SorteCicloService` (job de 5 s) dispara uma vez por dia no
  `lembreteHorario` e enfileira pushes **só para inscritos que ainda não rasparam hoje**, em lotes
  na `NOTIFICATION_QUEUE`, com `data.screen = 'associado-da-sorte'`. Isso é push em massa, que o
  prompt original deixava fora do escopo: precisa de "ok" explícito do marketing sobre horário e
  frequência (pergunta 13). Fica para depois do MVP se não houver resposta.

### 4.7 Ajustes menores

- Analytics: novas telas/ações na allowlist (`loja`, `loja_comprar`, `raspar`, `convite`).
- `docs/ASSOCIADO_DA_SORTE.md`: reescrever regras, contrato e erros novos
  (`NAO_INSCRITO`, `LIMITE_DIARIO`, `CAMPANHA_TRAVADA`, `CAMPANHA_FORA_DO_PERIODO`, `LIMITE_POR_ASSOCIADO`).
- Seed de demonstração: campanha publicada com momentos a cada 2 min nas próximas horas, loja com
  um item de cada tipo, metade dos associados de demo inscritos e metade não.
- `scripts/sorte-aceite.mjs`: trocar os cenários de corrida/sorteio por raspadinha com horário,
  concorrência no mesmo momento, loja com estoque 1 e campanha travada.
- `scripts/sorte-proxy-demo.mjs`: responder também `produto-vinculado-veiculo` para os CPFs de demo.

## 5. Painel (`/home/samuel/Documentos/AdminSorte`)

| Tela | Mudança |
|---|---|
| Visão geral | Raspadas hoje, vouchers saídos/pendentes no cronograma, créditos em circulação, **retiradas aguardando contato** (destaque) |
| **Campanha** (nova, substitui Rodadas) | Dados da campanha, importação do CSV com pré-visualização, linha do tempo dos momentos (liberado / ganho por quem / pendente), botão **Publicar e travar** com confirmação dupla, **Exportar auditoria** |
| **Loja da Sorte** (era Prêmios) | Tipo, custo em créditos, estoque, limite por associado, instruções de retirada, na loja sim/não |
| **Retiradas** (era Ganhadores) | Filtro por origem (Loja / Voucher); badge de novas; WhatsApp com mensagem padrão por tipo de produto |
| Associados | Coluna "inscrito" com origem e data da verificação; extrato com **tentativas que falharam e motivo**; botão "reverificar no SGA"; importação de CSV de inscritos |
| Créditos | Sem mudança |
| Configurações | Código do produto SGA por base, raspadas por dia, carência, horário do lembrete, texto e link do convite; remove faixas de probabilidade e check-in da tela |

Rodadas sai do menu (a rota continua acessível por URL só se a flag estiver ligada).

## 6. App (`AppAssociado`, sem dependência nativa nova)

- **Tela principal da promoção** com dois estados:
  - não inscrito → tela de convite (texto e botão vindos da config; sem saldo nem loja);
  - inscrito → saldo, card da raspadinha, atalho da Loja da Sorte, Meus prêmios, Extrato.
- **Raspadinha** (`components/sorte/Raspadinha.tsx` já existe): chama `POST /raspar` antes de
  liberar a raspagem; resultado "Você ganhou um voucher de 120 créditos!" com haptics, ou
  "Não foi dessa vez" com o horário em que pode raspar de novo.
- **Loja da Sorte** (nova tela `app/associado-da-sorte/loja.tsx` + detalhe do produto): grade com
  foto, custo e "últimas unidades"; confirmação de compra com saldo antes/depois; tela de sucesso
  com as instruções de retirada.
- Remover da navegação: listas de rodadas, corrida, "Avise-me"; `RodadaCard`, `RodadaAcao` e
  `rodada/[id].tsx` ficam no código, sem rota no menu.
- Atalho "ver boleto" na tela da promoção (o gestor quer que o associado veja o boleto ao entrar),
  reaproveitando a tela de boletos que já existe. Só um link, sem lógica nova.
- `npx tsc --noEmit` limpo; teste no emulador com o proxy de demonstração.

## 7. Ordem de execução e estimativa

| Dia | Entrega | Verificação |
|---|---|---|
| Sex 13 | Mandar as perguntas ao marketing; commit do piloto atual na branch como ponto de partida | — |
| Seg 16 | Migration v2, campanha + momentos + importação CSV, raspadinha nova com testes de horário e concorrência | `npm run verify` |
| Ter 17 | Elegibilidade SGA (+ importação de CSV), Loja da Sorte, tentativas, ocultar rodadas/check-in; seed e roteiro de aceite atualizados | `node scripts/sorte-aceite.mjs` |
| Qua 18 | Painel (Campanha, Loja, Retiradas, Associados, Configurações) e app (convite, raspadinha, loja) | Build do painel, `tsc` do app, roteiro manual no emulador |
| Qui 19 | Folga para ajustes da validação com o marketing; lembrete diário se aprovado; exportação de auditoria refinada | Revisão com o gestor |

**Corte do MVP (quarta):** inscrição, campanha travada com momentos, raspadinha, loja com
estoque, retiradas com WhatsApp, extrato com tentativas. **Depois do MVP:** lembrete diário em
massa, e-mail de aviso de retirada, sorteio do carro e das motos, check-in/marcos.

## 8. Riscos

- **Código do produto no SGA** é a única dependência externa nova; sem ele, a inscrição roda só
  por importação de CSV (o que já atende o MVP).
- **Raspadas ilimitadas** concentram os vouchers em quem raspa mais; vale mostrar isso ao gestor
  junto com a pergunta 1.
- **Trava da campanha** precisa ser à prova de erro do operador: publicar exige confirmação dupla e
  não existe "despublicar". Se a planilha vier errada depois de publicada, o caminho é encerrar
  aquela campanha e publicar outra, e isso fica registrado para a auditoria.
- **Relógio:** a regra "não sai antes da hora" depende do relógio do servidor (`TZ=America/Sao_Paulo`
  e `NOW()` do MySQL). Conferir que o banco de produção usa o mesmo fuso, ou gravar e comparar
  tudo em UTC (recomendado).
- **Validade jurídica:** a regra de horário veio da reunião; confirmar o texto do regulamento
  aprovado antes de publicar a primeira campanha real.
