# Associado da Sorte v2 — adequar o piloto à visão do marketing

Você vai evoluir o piloto do Associado da Sorte, que já existe nos três repositórios abaixo, para a
visão definida pelo marketing em 13/11/2026. Leia antes de começar:

- `docs/ASSOCIADO_DA_SORTE_REUNIAO_MARKETING.md` — o que o marketing pediu (com tempos do áudio).
- `docs/ASSOCIADO_DA_SORTE_PLANO_ADEQUACAO.md` — o mapeamento piloto → visão nova (seção 2 já com as respostas de 13/11).
- `docs/ASSOCIADO_DA_SORTE.md` — regras e contrato do piloto.
- `docs/ASSOCIADO_DA_SORTE_PROMPT.md` — o prompt original. **Todas as regras de Git, banco, app sem
  dependência nativa, pacotes, logs e escopo dele continuam valendo**, exceto onde este documento
  diz o contrário.

Repositórios (todos na branch `feat/associado-da-sorte`; não faça commit nem push):
1. Backend: `beneficios-api` (este repositório), módulo `src/associado-sorte`.
2. Painel: `/home/samuel/Documentos/AdminSorte/`.
3. App: `/home/samuel/Downloads/backup-samuel-cachyos/AppAssociadoNewDesign/AppAssociado`
   (`android/app/build.gradle` e `android/gradle.properties` têm alterações do usuário: não edite,
   não descarte, não adicione ao stage).

Trabalhe na ordem backend → painel → app, sem pedir confirmação entre fases. Pare só diante de um
bloqueio real. Prazo combinado com o marketing: MVP até 18/11/2026.

## 1. A promoção, como ela passa a funcionar

O associado da base **MAIS_PRIME** inscrito no produto "Associado da Sorte" do SGA abre a Loja da
Sorte no app e **raspa uma raspadinha para descobrir se ganhou um voucher em créditos**
(1 crédito = R$ 1; créditos não expiram). Os vouchers saem de um **cronograma de momentos
premiados** importado de uma planilha e **travado** quando a campanha é publicada, por exigência de
auditoria do Ministério da Fazenda. Os créditos são gastos na **Loja da Sorte**, um catálogo de
produtos com preço em créditos e estoque. Cada compra avisa a equipe pelo painel e por e-mail, e a
equipe chama o associado no WhatsApp para combinar a retirada.

## 2. Regras de negócio

### 2.1 Base e inscrição
- Só a base `MAIS_PRIME` participa. Mantenha o código multi-base, mas restrinja por uma constante
  em `config/` (`SORTE_BASES_CONTEMPLADAS = ['MAIS_PRIME']`). Associado de outra base recebe a
  promoção como inativa (`ativa: false`), sem erro.
- **Inscrito** = associado com pelo menos um veículo que permite acesso ao app
  (`veiculoPermiteAcesso`, `src/associado/helpers/acesso-app.helper.ts`) e, nesse veículo, um
  produto com `codigo_produto` igual ao código configurado (padrão `"3677"`), `descricao` igual à
  descrição configurada (padrão `"ASSOCIADO DA SORTE"`, comparando sem acento, sem espaços nas
  pontas e sem diferenciar maiúsculas) e `situacao` = `ATIVO`. O código e a descrição precisam
  bater os dois.
  Exemplo de item retornado pelo SGA:
  `{ "codigo_produto": "3677", "descricao": "ASSOCIADO DA SORTE", "situacao": "ATIVO", ... }`.
- **Um associado = um participante**, mesmo com vários veículos inscritos. A chave é sempre o `userId`.
- Consulta ao SGA, sem rota nova do SGA:
  1. veículos via `GET ${SGA_BASE_URL}/associado/buscar/{cpf}` com
     `SgaAuthService.executeRequestWithAuth` (importe `HinovaModule`);
  2. produtos de cada veículo via `BeneficiosVeiculoService.getBeneficiosVeiculo` (adicione
     `exports: [BeneficiosVeiculoService]` ao `BeneficiosVeiculoModule`; a rota existente não muda).
     Pare no primeiro veículo que tiver o produto.
- Cache em `SorteInscricao` (`userId` PK, `inscrito`, `fonte` `SGA` | `MANUAL`, `verificadoEm`).
  A validade da verificação é configurável (padrão 6 h). Se o SGA falhar, use o último valor; se
  nunca houve verificação, responda `inscrito: false, motivo: 'VERIFICACAO_INDISPONIVEL'`, e o app
  mostra "tente mais tarde" em vez do convite.
- No painel, o operador pode reverificar no SGA ou marcar a inscrição à mão (`fonte: MANUAL`, com
  autor). A marcação manual prevalece até ser desfeita.
- Todas as rotas do app exigem inscrição, exceto `resumo` (devolve `inscrito` e os dados do
  convite) e `regulamento`. Erro: 403 `NAO_INSCRITO`.

### 2.2 Raspadinha (substitui o crédito diário por faixas)
- Configuração no painel: `raspadasPorDia` (≥ 1) e `intervaloMinimoMinutos` entre duas raspadas
  (≥ 0).
- A janela é o **dia do calendário em America/Sao_Paulo** (use `diaSaoPaulo` e
  `proximaViradaDoDia`). Raspada não usada **não acumula** para o dia seguinte.
- Toda raspada fica registrada em `SorteRaspada` (`userId`, `baseOrigin`, `campanhaId`, `dia`,
  `criadoEm`, `resultado` `GANHOU` | `NAO_GANHOU`, `momentoId?`, `creditos`). É o histórico do
  associado e entra na exportação de auditoria. `SorteColetaDiaria` deixa de ser escrita; a tabela
  fica.
- Transação `POST /associado-sorte/raspar` (READ COMMITTED, `SorteUnidadeTrabalho`). Trava, nesta
  ordem, o **momento** e depois a **carteira**:
  1. Fora da transação: limite de requisições, inscrição e campanha publicada dentro do período.
  2. Trava a carteira, conta as raspadas de hoje e lê a última: `LIMITE_DIARIO` (409) ou
     `INTERVALO` (409, com `proximaRaspadaEm`).
  3. Carência: se o associado ganhou um voucher há menos de `carenciaDias`, a raspada é registrada
     como `NAO_GANHOU`, sem olhar os momentos.
  4. Busca o momento **mais antigo com `liberaEm <= agora` e ainda sem ganhador** da campanha, com
     `FOR UPDATE` (use `SKIP LOCKED` só se `SELECT VERSION()` do banco suportar; registre a versão
     no relatório).
  5. Encontrou: grava o ganhador e a hora no momento, credita com `SorteCreditosService.lancar`
     (tipo `VOUCHER_RASPADINHA`) e cria a raspada como `GANHOU`. Não encontrou: cria como
     `NAO_GANHOU`.
  6. Resposta: `{ serverNow, resultado, creditos, saldo, raspadasRestantesHoje, proximaRaspadaEm }`.
- **Um momento nunca sai antes de `liberaEm`** e, sem ganhador, continua disponível nos dias
  seguintes até alguém ganhar. Um associado pode ganhar vários vouchers, respeitando a carência.

### 2.3 Jornada de check-in (bônus opcional)
- `jornadaAtiva` (padrão `false`) mais os marcos (`[{ dias, bonus }]`), editáveis no painel.
- O dia conta para a sequência quando o associado faz pelo menos uma raspada (ganhando ou não).
  No primeiro dia de cada marco atingido, a primeira raspada credita o bônus (`BONUS_SEQUENCIA`) na
  mesma transação. Reaproveite `calcularSequencia`, `sequenciaVigente` e `proximoMarco` de
  `helpers/sorte.helpers.ts` e os campos `sequenciaDias` / `ultimoDiaColetado` da carteira.
- Com a jornada desligada, nada de sequência aparece no app nem no resumo.

### 2.4 Campanha e cronograma
- `SorteCampanha`: `baseOrigin`, `nome`, `inicio`, `fim`, `estado` (`RASCUNHO` → `PUBLICADA` →
  `ENCERRADA`), `publicadaEm`, `publicadaPorId` / `publicadaPorNome`, `hashCronograma`. Só uma
  campanha publicada por base.
- `SorteMomentoPremiado`: `campanhaId`, `liberaEm`, `creditos`, `descricao`, `userId?`, `ganhoEm?`,
  `raspadaId?`.
- Importação por **CSV** com as colunas `data;hora;creditos;descricao`:
  - `data` em `DD/MM/AAAA`, `hora` em `HH:MM` (horário de Brasília), `creditos` inteiro > 0;
  - aceite `;` ou `,` como separador e cabeçalho em qualquer ordem;
  - valide datas dentro da campanha e rejeite linhas duplicadas;
  - pré-visualização com erros por linha antes de gravar.

  O formato ainda pode mudar: isole o parser num helper com testes, para trocar sem mexer no resto.
- **Publicar** grava o SHA-256 do cronograma e trava a campanha. Depois disso, criar, editar ou
  apagar momento e mudar `inicio` / `fim` respondem 409 `CAMPANHA_TRAVADA`; não existe
  "despublicar". Produtos da loja continuam editáveis. Encerrar a campanha antecipadamente é
  permitido e fica registrado.
- Exportação de auditoria em CSV: dados da campanha, hash, cada momento com ganhador (nome, CPF
  mascarado, hora da raspada) e o histórico de raspadas do período.

### 2.5 Loja da Sorte
- `SortePremio` passa a ser o produto da loja. Campos novos:
  - `tipo` (`FISICO` | `SERVICO_MAIS_PRIME` | `CUPOM_PARCEIRO`);
  - `custoCreditos`, `naLoja`, `limitePorAssociado` (0 = sem limite);
  - `instrucoesRetirada` (texto mostrado após a compra, ex.: "apresente este cupom na Pagé
    Amortecedores"), `ordem`.
- `GET /associado-sorte/loja` e `POST /associado-sorte/loja/:premioId/comprar`. A transação é a da
  vitrine atual (`SorteResgateService.resgatarNaTransacao`), sem rodada: trava o prêmio e depois a
  carteira; verifica estoque (`ESGOTADO`), limite por associado (`LIMITE_POR_ASSOCIADO`) e saldo
  (`CREDITOS_INSUFICIENTES`); registra o ganhador, baixa o estoque com movimento e debita com
  `COMPRA_LOJA`. Mantenha o semáforo e a recusa rápida.
- `SorteGanhador` passa a representar também a compra: `rodadaId` opcional, `origem` com o valor
  novo `LOJA`. Remova `@@unique([rodadaId, userId])`; a unicidade da corrida passa a ser garantida
  na transação.
- Serviços Mais Prime (ex.: reboque por 1 mês, plano dental) são ativados à mão no SGA pela equipe;
  o sistema só registra o pedido.

### 2.6 Notificações para a equipe (cada compra na loja)
- **Área de Notificações no painel:** tabela `SorteNotificacaoAdmin` (`tipo` `NOVA_RETIRADA` |
  `ESTOQUE_BAIXO` | `ESTOQUE_ESGOTADO`, `titulo`, `mensagem`, `ganhadorId?`, `premioId?`, `lidaEm?`,
  `lidaPorNome?`, `createdAt`). Rotas para listar (filtro lidas/não lidas), contar não lidas,
  marcar como lida e marcar todas.
- **E-mail** para `emailNotificacoes` (configurável no painel; padrão `marketing@teste.com.br`; aceita
  vários separados por vírgula). O e-mail traz produto, código do pedido, nome, CPF mascarado,
  telefone mascarado e link do painel. Envie por um job `sorte-email-retirada` na
  `ASSOCIADO_SORTE_QUEUE`, com 3 tentativas, depois do commit: falha no e-mail nunca desfaz a compra.
  Reaproveite `MailService` (global) com um método novo no padrão dos que já existem. Se
  `docs/ARQUITETURA_ALVO_2026-09.md` classificar `MailService` como god service, monte o e-mail no
  módulo reaproveitando o mesmo transporte e explique no relatório.
- **WhatsApp do marketing:** campo `whatsappMarketing` (vazio por padrão). Preenchido, cada
  notificação de retirada mostra "Enviar no WhatsApp do marketing", que abre
  `wa.me/<número>?text=<resumo do pedido>`. Vazio, o botão não aparece.
- Push para o associado ganhador/comprador continua como no piloto.

### 2.7 Lembretes de raspadinha por push (programáticos)
- `lembretesAtivos` (padrão `true`) e uma janela de envio (`lembreteInicio` / `lembreteFim`, padrão
  `08:00`–`21:00`).
- No job de 5 s (`SorteCicloService.executar`, um passo novo isolado em try/catch), envie um push
  "Sua raspadinha está liberada" a cada associado **inscrito** que:
  - ainda tem raspadas no dia;
  - já cumpriu o intervalo mínimo (`proximaRaspadaEm <= agora`);
  - não foi avisado daquela liberação.
- Controle em `SorteCarteira.lembreteRaspadaEm`, com o horário de liberação já avisado; nunca dois
  pushes para a mesma liberação.
- Se a liberação cair fora da janela, espere o início da próxima janela, sem acumular avisos.
- Envio em lotes pela `NOTIFICATION_QUEUE` (`addBulk`), como `SorteNotificacoesService.enviarLembretes`,
  com `data: { type: 'internal_route', screen: 'associado-da-sorte' }`.
- Isto substitui o "push em massa" que o prompt original deixava fora do escopo. Limite cada
  ciclo a um lote configurável (padrão 500) e continue no ciclo seguinte.
- O primeiro aviso do dia é a liberação da 00:00, entregue no início da janela, só para quem tem
  token de push.

### 2.8 O que sai de cena (sem apagar código)
- Rodadas de SORTEIO / CORRIDA / RESGATE e o "Avise-me": coloque atrás de
  `SorteConfig.rodadasHabilitadas` (padrão `false`). As rotas do app respondem 404 com a flag
  desligada; o painel esconde o menu. O job continua apurando o que já existir. Código, testes e
  tabelas ficam, porque o sorteio do carro e das motos ainda não foi definido.
- Faixas de probabilidade (`faixasRaspadinha`) e `fonteCreditoDiario`: sem uso; saem do painel.
- **Contrato do app:** `resumo` muda de forma (ver 3.2). Atualize `docs/ASSOCIADO_DA_SORTE.md` e
  ajuste o app na mesma entrega. As rotas fora do módulo continuam sem mudança.

### 2.9 Registro de tentativas
- `SorteTentativa` (`userId`, `baseOrigin`, `acao` `RASPAR` | `COMPRAR` | `ACESSAR`, `codigo` do
  erro, `contexto` JSON curto sem CPF ou telefone, `createdAt`). É gravada no `catch` de raspar e
  comprar e no 403 `NAO_INSCRITO`, sem bloquear a resposta (`.catch` com log).
- Aparece no extrato do associado no painel como "tentou X e não conseguiu: motivo".

## 3. Entregas

### 3.1 Banco
Nova migration `associado_sorte_v2`. Antes de rodar, confira para onde o `DATABASE_URL` aponta,
sem imprimir a senha; só use `migrate dev` em banco local. Nunca rode `migrate reset`; se houver
drift, pare e reporte.

`SorteConfig` ganha:
- `produtoSgaCodigo` (`"3677"`), `produtoSgaDescricao` (`"ASSOCIADO DA SORTE"`), `inscricaoValidadeHoras`;
- `raspadasPorDia`, `intervaloMinimoMinutos`;
- `jornadaAtiva` (os marcos reaproveitam `marcosSequencia`);
- `lembretesAtivos`, `lembreteInicio`, `lembreteFim`;
- `whatsappConvite`, `mensagemConvite` (padrão: "Olá, sou associado da Mais Prime e gostaria de
  saber sobre a promoção do associado da sorte");
- `emailNotificacoes`, `whatsappMarketing`, `rodadasHabilitadas`.

Os demais modelos e alterações estão nas seções 2.1 a 2.9.

### 3.2 Backend (`src/associado-sorte`)
- **Serviços novos:**
  - `SorteInscricaoService`;
  - `SorteCampanhaService`, com o parser de CSV num helper testado;
  - `SorteRaspadinhaService`, que substitui `SorteColetaDiariaService`;
  - `SorteLojaService`, adaptando `SorteResgateService`;
  - `SorteNotificacoesAdminService` (notificações do painel + job de e-mail);
  - `SorteLembreteRaspadaService`;
  - `SorteTentativaService`.
- **Rotas do app:**
  - `GET resumo` → `{ ativa, inscrito, motivo?, convite: { whatsapp, mensagem, link }, saldo,
    raspadinha: { raspadasRestantesHoje, proximaRaspadaEm }, jornada?, campanha }`;
  - `POST raspar`;
  - `GET loja` e `POST loja/:premioId/comprar`;
  - `meus-premios`, `extrato` e `regulamento` como estão.
- **Rotas do painel (MARKETING):**
  - campanha: CRUD, importar CSV (pré-visualizar e confirmar), publicar, encerrar, exportar auditoria;
  - momentos (listar com status);
  - inscrições: reverificar, marcar e desmarcar à mão;
  - notificações: listar, contar, marcar lidas;
  - produtos da loja (as rotas de prêmios, com os campos novos);
  - config com os campos novos.
- **Erros novos:** `NAO_INSCRITO`, `LIMITE_DIARIO`, `INTERVALO`, `CAMPANHA_TRAVADA`,
  `CAMPANHA_FORA_DO_PERIODO`, `SEM_CAMPANHA`, `LIMITE_POR_ASSOCIADO`.
- **Analytics:** telas e ações novas na allowlist (`loja`, `loja_produto`, `raspar`, `loja_comprar`,
  `convite_whatsapp`).
- **Testes** (no padrão de `testing/sorte-tx.memoria.ts`):
  - parser de CSV;
  - momento não sai às 14:59:59 e sai às 15:00:00;
  - concorrência: 10 raspadas simultâneas e 1 momento liberado → exatamente 1 ganhador;
  - momento de ontem sai hoje;
  - limite diário e intervalo, com a virada do dia em São Paulo;
  - carência; jornada com e sem bônus;
  - campanha travada recusa edição;
  - loja: estoque 1 com compras simultâneas, limite por associado, saldo insuficiente;
  - lembrete enviado uma única vez por liberação e respeitando a janela;
  - inscrição: código e descrição precisam bater, produto INATIVO não vale, dois veículos contam
    um participante, SGA fora do ar usa o cache.

  `npm run verify` precisa passar.
- **Seed e scripts:**
  - `prisma/seed-associado-sorte-demo.ts`: campanha publicada com momentos a cada 2 min nas
    próximas horas, loja com um produto de cada tipo, metade dos associados de demonstração
    inscritos (`fonte: MANUAL`) e metade não.
  - `scripts/sorte-aceite.mjs`: troque os cenários de rodada pelos da seção 4.
  - `scripts/sorte-proxy-demo.mjs`: responda `produto-vinculado-veiculo` para os CPFs de demonstração.
- **Documentação:** reescreva `docs/ASSOCIADO_DA_SORTE.md` (regras, contrato, erros, decisões) e
  atualize a entrada do domínio no `CLAUDE.md`.

### 3.3 Painel (`AdminSorte`)

| Tela | O que muda |
|---|---|
| Visão geral | Raspadas hoje, vouchers saídos/pendentes, créditos em circulação, retiradas aguardando contato e notificações não lidas |
| **Campanha** (substitui Rodadas) | Dados, importação de CSV com pré-visualização e erros por linha, linha do tempo dos momentos, "Publicar e travar" com confirmação digitando o nome da campanha, "Encerrar", "Exportar auditoria" |
| **Loja da Sorte** (era Prêmios) | Campos da seção 2.5 |
| **Retiradas** (era Ganhadores) | Filtro por origem; WhatsApp com o associado como já existe |
| **Notificações** (nova) | Lista, filtro lidas/não lidas, marcar lida/todas, link para a retirada, botão "Enviar no WhatsApp do marketing" quando configurado; contador no menu atualizado a cada 30 s |
| Associados | Coluna "inscrito" (origem e data), reverificar no SGA, marcar à mão, extrato com raspadas e tentativas que falharam |
| Configurações | Inscrição (código, descrição, validade), raspadas por dia, intervalo, carência, jornada e marcos, lembretes (liga/desliga, janela), convite (WhatsApp e mensagem), notificações (e-mails, WhatsApp do marketing), rodadas habilitadas |

`npm run build` precisa passar.

### 3.4 App (`AppAssociado`, sem dependência nativa nova)
- A aba e o item de menu da promoção passam a se chamar **"Loja da Sorte"**.
  - **Não inscrito:** tocar na aba, no menu ou no destaque da home abre direto
    `wa.me/<whatsappConvite>?text=<mensagemConvite>` (via `Linking`), sem tela intermediária. Se o
    número não estiver configurado, mostre um aviso simples.
  - **Verificação indisponível:** mostre "tente mais tarde" em vez de abrir o WhatsApp.
- Tela principal para inscritos:
  - saldo;
  - card da raspadinha com raspadas restantes hoje e a contagem até a próxima (relógio do
    servidor, `use-relogio-servidor`);
  - jornada (só se ativa);
  - grade da Loja; Meus prêmios; Extrato; atalho "Ver boleto" para a tela de boletos existente.
- Raspadinha (reaproveite `components/sorte/Raspadinha.tsx`): chama `POST raspar` antes de liberar
  a raspagem; ao revelar, "Você ganhou um voucher de N créditos!" (haptics) ou "Não foi dessa vez",
  com o horário da próxima.
- Loja: grade, detalhe do produto, confirmação com saldo antes e depois, tela de sucesso com
  `instrucoesRetirada` e código do pedido.
- Push de lembrete abre a tela principal.
- Telas de rodada e "Avise-me" ficam fora da navegação; os arquivos ficam.
- `npx tsc --noEmit` sem erros novos.

## 4. Critérios de aceite (verifique e reporte cada um)
1. Associado com o produto 3677 / "ASSOCIADO DA SORTE" ATIVO em um veículo raspa; sem o produto,
   ou com o produto INATIVO, recebe `NAO_INSCRITO`; com dois veículos inscritos, aparece uma vez na
   lista de participantes.
2. Associado da base MAIS_PRIME_RS vê a promoção inativa.
3. Com `raspadasPorDia = 2` e `intervaloMinimoMinutos = 60`: a segunda raspada antes de 60 min
   recebe `INTERVALO`; a terceira no dia recebe `LIMITE_DIARIO`; à 00:00 de São Paulo o contador
   volta a 2, sem acumular.
4. Momento das 15:00: raspada às 14:59 não ganha; a primeira depois das 15:00 ganha; um momento não
   ganho ontem sai hoje.
5. 10 raspadas simultâneas com um momento liberado → exatamente um ganhador, saldo creditado uma vez.
6. Campanha publicada recusa edição de momento (409 `CAMPANHA_TRAVADA`); a exportação traz o
   mesmo hash da publicação.
7. Compra na loja: debita, baixa estoque, cria a notificação no painel, enfileira o e-mail para
   `emailNotificacoes` e, com `whatsappMarketing` preenchido, mostra o link wa.me. Estoque 1 com
   duas compras simultâneas → uma sucede, a outra recebe `ESGOTADO`.
8. Lembrete: o associado com raspada liberada recebe um push só uma vez por liberação e nada fora da
   janela configurada.
9. Jornada ligada com marco de 3 dias: o bônus entra uma vez no terceiro dia seguido; desligada,
   nenhum bônus.
10. Não inscrito tocando na aba "Loja da Sorte" abre o WhatsApp com a mensagem configurada.
11. O histórico de raspadas e as tentativas que falharam aparecem no extrato do associado no painel.
12. Com `rodadasHabilitadas = false`, as rotas de rodada do app respondem 404 e o painel não mostra
    o menu.

## 5. Fora do escopo
- Sorteio do carro e das motos.
- Base MAIS_PRIME_RS.
- Expiração de créditos.
- Integração com o app de estoque do marketing.
- Envio automático de WhatsApp: só links wa.me.
- Ativação automática de serviços no SGA.
- Build nativo, publicação de OTA e deploy.

## 6. Relatório final
Inclua:
- o que foi entregue e como rodar;
- o resultado de cada critério da seção 4 e como foi verificado;
- o status da migration e a versão do banco (`SELECT VERSION()`);
- as decisões tomadas onde este documento deixou margem;
- as pendências: confirmar o e-mail real do marketing, o número do WhatsApp do marketing, o formato
  final da planilha e o texto do regulamento.
