# Tarefa: implementar o piloto do "Associado da Sorte" (backend + painel web + app)

## 1. Objetivo

Construir uma versão de teste, funcional de ponta a ponta, de uma promoção gamificada chamada
**Associado da Sorte**, para o time de marketing validar. O associado junta créditos todos os dias
no app e usa esses créditos para concorrer a prêmios físicos com estoque controlado. O marketing
administra tudo por um painel web novo.

São três entregas, nesta ordem:

1. **Backend** — módulo novo no `beneficios-api` (NestJS).
2. **Painel web** — aplicação React nova, salva em `/home/samuel/Documentos/AdminSorte/`.
3. **App** — tela nova no app Expo dos associados.

O marketing ainda não fechou as regras. Por isso o valor desta entrega está na **flexibilidade**:
o que for regra de promoção (mecânica, custo, horários, fonte de créditos, estoque) precisa ser
configurável pelo painel, sem deploy.

## 2. Repositórios e regras de trabalho

| Parte | Caminho |
|---|---|
| Backend | `/home/samuel/Downloads/backup-samuel-cachyos/Users/leuma/Desktop/Projetos/App-associado/beneficios-api` |
| App | `/home/samuel/Downloads/backup-samuel-cachyos/AppAssociadoNewDesign/AppAssociado` |
| Painel novo | `/home/samuel/Documentos/AdminSorte/` (existe e está vazia) |
| Painel de referência (somente leitura) | `/home/samuel/Downloads/backup-samuel-cachyos/Users/leuma/Desktop/Projetos/protecto-admin-suite` |

Leia antes de escrever código:

- Backend: `CLAUDE.md`, `docs/ARQUITETURA_ALVO_2026-09.md` (regras de dependência e checklist de PR)
  e `docs/PARCEIROS_DIRETOS.md`. O módulo `src/direct-partners` é o modelo a seguir: controller de
  app e de painel separados, repository, publicação por base, resgate em transação com
  `SELECT ... FOR UPDATE`.
- App: `brands/README.md` (regras de cor e tipografia), `lib/moti-presets.ts` (regras de animação),
  e o fluxo do Clube de Vantagens (`app/(tabs)/beneficios.tsx`, `components/beneficios/`,
  `hooks/use-parceiros-diretos.ts`). O `README.md` da raiz do app está desatualizado; ignore-o.

Regras:

- **Git:** crie a branch `feat/associado-da-sorte` no backend e no app. Não faça commit em `main`
  e não faça push. No app, `android/app/build.gradle` e `android/gradle.properties` têm alterações
  locais que não são suas: não edite, não descarte e não adicione ao stage. Em `AdminSorte`, rode
  `git init`.
- **Banco:** antes de qualquer comando Prisma que toque o banco, confira para onde o `DATABASE_URL`
  aponta (sem imprimir a senha). Se for claramente um banco local ou de desenvolvimento, use
  `npx prisma migrate dev --name associado_sorte`. Se não for, ou se houver dúvida, não rode: escreva
  o SQL da migration à mão em `prisma/migrations/<timestamp>_associado_sorte/`, no padrão das
  existentes, rode só `npx prisma generate` e avise no relatório. Nunca rode `migrate reset` nem
  aceite um prompt de reset; se o Prisma acusar drift, pare e reporte.
- **App sem dependência nativa nova.** O app é dev client com `runtimeVersion` fixo `1.3.1` e
  atualização OTA. O piloto precisa poder sair por OTA, então use só o que já está instalado
  (`react-native-reanimated`, `react-native-gesture-handler`, `react-native-svg`, `moti`,
  `expo-haptics`, `expo-linear-gradient`, `expo-image`). Não instale Skia, Lottie nem bibliotecas
  de confete ou bottom sheet.
- **Pacotes:** só `npm` está instalado na máquina (Node 22).
- **Contratos existentes não mudam.** Rotas, payloads e contract specs atuais do backend ficam como
  estão. Não acrescente linhas a `notifications.service.ts` (é um god service); consuma o que o
  `NotificationsModule` já exporta.
- Trabalhe até o fim sem pedir confirmação entre as fases. Pare só diante de um bloqueio real
  (por exemplo, banco inacessível) e diga exatamente o que faltou.

## 3. Modelo de domínio

| Conceito | O que é |
|---|---|
| **Configuração da promoção** | Uma por base (`MAIS_PRIME`, `MAIS_PRIME_RS`). Liga ou desliga a promoção, define a fonte do crédito diário, textos, regulamento e WhatsApp de suporte. |
| **Carteira e extrato** | Saldo de créditos do associado e o histórico de lançamentos (nunca editado, só acrescentado). |
| **Crédito diário** | Uma coleta por dia por associado: raspadinha (valor sorteado) ou check-in (valor fixo). |
| **Prêmio** | Item físico com foto, descrição e estoque. |
| **Rodada** | Um prêmio colocado em disputa numa data e hora, com uma mecânica, publicado em uma ou mais bases. A agenda semanal é o conjunto de rodadas. |
| **Participação** | Inscrição de um associado numa rodada de sorteio. |
| **Ganhador** | Quem levou uma unidade do prêmio, com código e situação de entrega. |

### Mecânicas de rodada

- **SORTEIO** — entre a abertura e o encerramento o associado se inscreve. No encerramento o sistema
  sorteia os ganhadores entre os inscritos.
- **CORRIDA** — o botão de resgate libera exatamente no horário de abertura. Cada associado que
  clicar enquanto houver unidade leva uma. É o "primeiro que clicar leva".
- **RESGATE** — vitrine: troca direta de créditos pelo item, enquanto houver unidade e a janela
  estiver aberta. Sem sorte e sem hora marcada de disputa.

CORRIDA e RESGATE usam a mesma operação no servidor ("resgatar uma unidade"). A diferença é de
apresentação no app e de regras: RESGATE sempre consome créditos e não tem carência.

## 4. Regras de negócio

### 4.1 Créditos

- Créditos são inteiros. O saldo nunca fica negativo.
- Toda alteração de saldo gera um lançamento no extrato, na mesma transação, com o saldo resultante.
  Tipos: `RASPADINHA`, `CHECKIN`, `BONUS_SEQUENCIA`, `AJUSTE_ADMIN`, `PARTICIPACAO_SORTEIO`,
  `RESGATE`, `ESTORNO`. Deixe o tipo fácil de estender: o marketing quer criar outras formas de
  ganhar crédito depois (pagar boleto em dia, indicar alguém, abastecer). Não implemente essas
  agora.
- Créditos não expiram no piloto.
- O painel pode lançar um ajuste manual (positivo ou negativo) com motivo obrigatório. Fica
  registrado qual usuário do painel fez.

### 4.2 Crédito diário

- Uma coleta por associado por dia. "Dia" é a data em `America/Sao_Paulo`.
- A fonte ativa é configuração da base: `RASPADINHA`, `CHECKIN` ou `NENHUMA`.
- **Raspadinha:** o valor é decidido **pelo servidor**, a partir de uma lista de faixas com peso
  configurada no painel (exemplo: 1 crédito peso 60, 3 créditos peso 30, 10 créditos peso 10). O app
  só anima a revelação de um valor que já veio do servidor. Use `crypto.randomInt`.
- **Check-in:** valor fixo configurado.
- **Sequência de dias:** coletar em dias seguidos aumenta a sequência; pular um dia volta para 1.
  O painel configura marcos de bônus (exemplo: 3 dias +2, 7 dias +10). Ao coletar no dia do maior
  marco, a sequência recomeça no dia seguinte.
- **Idempotência:** repetir a coleta no mesmo dia devolve 200 com o mesmo resultado e
  `jaColetado: true`, sem creditar de novo. Garanta com índice único `(userId, dia)` no banco, e não
  só com verificação em código.

### 4.3 Rodadas

Campos que o painel define: prêmio, mecânica, quantidade de unidades, custo em créditos, modo do
crédito, bilhetes máximos por associado (só SORTEIO), abertura, encerramento, bases, título
opcional.

- **Modo do crédito:** `CONSOME` (debita ao participar ou resgatar) ou `SALDO_MINIMO` (basta ter o
  saldo; nada é debitado). Em `SALDO_MINIMO` cada associado tem um bilhete só.
- **SORTEIO:** cada bilhete custa o valor da rodada. Na apuração, sorteie `quantidade` ganhadores
  **distintos**, com chance proporcional aos bilhetes, usando `crypto.randomInt`. Com menos inscritos
  que unidades, todos ganham. Sem inscritos, a rodada encerra sem ganhador e o estoque não muda.
  Guarde um resumo da apuração (total de inscritos, total de bilhetes, horário) para auditoria.
- **CORRIDA / RESGATE:** uma unidade por associado por rodada. Encerra quando as unidades acabam ou
  quando chega o horário de encerramento.
- **Estados gravados:** `RASCUNHO`, `PUBLICADA`, `APURANDO`, `ENCERRADA`, `CANCELADA`. O app só vê
  rodadas publicadas.
- **Fase exibida no app**, calculada pelo horário do servidor, sem depender de job: `EM_BREVE`
  (antes da abertura), `ABERTA`, `ESGOTADA`, `APURANDO`, `ENCERRADA`. O servidor valida a abertura
  comparando o relógio dele com o horário da rodada; não confie no relógio do aparelho.
- **Cancelar** uma rodada devolve os créditos consumidos (lançamento `ESTORNO`).
- **Edição:** depois da abertura, só título e encerramento podem mudar. Mecânica, custo e prêmio
  ficam travados.
- **Agenda semanal:** o painel pode duplicar uma rodada "repetindo semanalmente por N semanas".
  Isso cria N rodadas independentes em rascunho; não crie uma regra de recorrência.

### 4.4 Estoque

- O estoque do prêmio baixa **na mesma transação** que cria o ganhador, com um registro de
  movimentação (`ENTRADA`, `SAIDA_GANHADOR`, `AJUSTE`, `ESTORNO`), o estoque resultante e quem fez.
- Ao publicar uma rodada, valide que a quantidade cabe no estoque já descontando as unidades
  restantes de outras rodadas publicadas do mesmo prêmio. Se não couber, responda 422
  `ESTOQUE_INSUFICIENTE`.
- Se o estoque estiver zerado na hora de premiar (por ajuste manual), ninguém leva: 409 `ESGOTADO`
  no resgate; no sorteio, premie só até onde o estoque alcançar e registre isso no resumo.
- Ao cancelar um ganhador, o painel escolhe se a unidade volta ao estoque.

### 4.5 Ganhador e entrega

- Cada ganhador recebe um **código curto único** do prêmio, que a equipe usa para conferir a
  identidade.
- Situação da entrega: `AGUARDANDO_CONTATO` → `EM_CONTATO` → `ENTREGUE`, ou `CANCELADO`. O painel
  muda a situação e registra observações.
- O backend não guarda telefone do associado. Na tela "Você ganhou", o app pede que o ganhador
  **confirme o WhatsApp de contato**, e o número fica gravado no registro do ganhador.
- **WhatsApp é por link wa.me, e link wa.me não envia nada sozinho.** São dois botões:
  - no app: "Falar com a equipe", que abre `wa.me/<WhatsApp de suporte da base>` com mensagem pronta
    contendo o nome do prêmio e o código;
  - no painel: "Chamar no WhatsApp", que abre `wa.me/<telefone confirmado>` com mensagem pronta.
    Fica desabilitado enquanto o ganhador não confirmar o número.
- Lista pública de ganhadores no app: só primeiro nome e inicial do sobrenome ("Samuel F."), e só
  se a base estiver configurada para exibir.

### 4.6 Elegibilidade e antiabuso

- Participa quem tem pelo menos um veículo `ATIVO`: a mesma regra do Clube de Vantagens, aplicada
  no app com `useVeiculoAtivo` (`hooks/use-veiculo-ativo.ts`). O servidor valida `user.isActive` e
  que a promoção está ativa na base do JWT. Limitação conhecida e aceita no piloto: a situação do
  veículo vem do SGA e não é revalidada no servidor; a equipe confere antes de entregar.
- **Carência:** a base configura quantos dias um ganhador fica sem poder ganhar de novo em SORTEIO e
  CORRIDA (0 desliga). No sorteio, quem está em carência não se inscreve e é pulado na apuração.
- **Limite de requisições** leve por associado em coletar, participar e resgatar, com `INCR` +
  `EXPIRE` no Redis, no molde de `analytics.service.ts` (linhas 296-320) e do provider em
  `src/beneficios/providers/alloyal-redis.provider.ts`. Acima do limite, 429.
- A base do associado vem sempre do JWT (`@BaseOrigin()`), nunca do corpo da requisição.

### 4.7 Notificações

- **Ganhador:** push imediato, enviado **depois** do commit da transação, com
  `data: { type: 'internal_route', screen: 'associado-da-sorte/premio/<id>' }`. O app passa `screen`
  por `toLowerCase()`, então rotas e parâmetros precisam ser minúsculos. Falha de push não desfaz a
  vitória: o associado também vê o prêmio ao abrir a tela.
- **Avise-me:** o associado pode pedir lembrete de uma rodada; quem pediu recebe push alguns minutos
  antes da abertura (antecedência em `config/` do módulo). Para lotes, enfileire na
  `NOTIFICATION_QUEUE` que já existe em vez de enviar em laço. **Este é o item de menor prioridade:
  implemente por último.**
- Envio individual: `NotificationsService.sendPushNotification(userId, token, titulo, corpo, data)`,
  exemplo em `src/fuel-session/processors/fuel-economy.processor.ts` (linhas 103-115).

## 5. Fase 1 — Backend

Crie `src/associado-sorte/` com a anatomia padrão (`controllers/`, `services/`, `repositories/`,
`dto/`, `mappers/`, `processors/`, `config/`, `enums/`) e registre o `AssociadoSorteModule` no
`AppModule`. Divida os serviços por responsabilidade (configuração, créditos, coleta diária,
prêmios e estoque, rodadas, resgate, apuração, ganhadores) em vez de um serviço único.

### 5.1 Dados (referência; ajuste nomes e detalhes ao que o código pedir, mantendo as regras)

Modelos Prisma em PascalCase com prefixo `Sorte`, sem `@@map`, seguindo os de `DirectPartner*`:

- `SorteConfig` — uma linha por `baseOrigin` (único): ativa, título, subtítulo, regulamento (texto),
  data de atualização do regulamento, WhatsApp de suporte, fonte do crédito diário, faixas da
  raspadinha (JSON), créditos do check-in, marcos de sequência (JSON), exibir ganhadores, carência
  em dias.
- `SorteCarteira` — por usuário (único): saldo, total ganho, sequência de dias, último dia coletado.
- `SorteCreditoLancamento` — usuário, base, tipo, valor com sinal, saldo após, rodada (opcional),
  descrição, usuário do painel (opcional), data.
- `SorteColetaDiaria` — usuário, dia (`@db.Date`), fonte, créditos, bônus, sequência;
  `@@unique([userId, dia])`.
- `SortePremio` — nome, descrição, imagem, valor estimado (opcional), estoque, ativo, exclusão
  lógica.
- `SorteEstoqueMovimento` — prêmio, tipo, quantidade com sinal, estoque após, motivo, autor.
- `SorteRodada` — prêmio, título, mecânica, quantidade, quantidade restante, custo, modo do crédito,
  bilhetes máximos, abertura, encerramento, estado, data e resumo da apuração (JSON), data do
  lembrete enviado.
- `SorteRodadaBase` — `@@id([rodadaId, baseOrigin])`.
- `SorteParticipacao` — rodada, usuário, base, bilhetes, créditos gastos;
  `@@unique([rodadaId, userId])`.
- `SorteLembrete` — rodada, usuário; `@@unique([rodadaId, userId])`.
- `SorteGanhador` — rodada, prêmio, usuário, base, código (único), origem, situação, telefone de
  contato, observação, datas; `@@unique([rodadaId, userId])`.

`baseOrigin` é `String @db.VarChar(40)` validado por `isTenantBase` / `@IsTenantBase()`
(`src/config/`), como em direct-partners. Não existe enum de base no Prisma.

### 5.2 Concorrência

Esta é a parte que não pode falhar: duas pessoas nunca levam a mesma unidade, e ninguém gasta o
mesmo crédito duas vezes.

- Use transação interativa do Prisma com `SELECT ... FOR UPDATE`, no padrão de
  `src/direct-partners/repositories/direct-partners.repository.ts` (linhas 265-288).
- Trave sempre na mesma ordem para evitar deadlock: **rodada → prêmio → carteira**.
- Dentro da transação de resgate, revalide tudo: estado e janela da rodada, unidades restantes,
  estoque, se o associado já ganhou nesta rodada, carência e saldo. Só então crie o ganhador, baixe
  a rodada e o estoque e lance o débito.
- **Recusa rápida:** a corrida concentra cliques no mesmo segundo, no mesmo processo e no mesmo
  pool de conexões que atende o resto da API. Antes de abrir a transação, faça uma leitura simples
  da rodada; se ela não está aberta ou já esgotou, responda na hora (`RODADA_NAO_ABERTA`,
  `ESGOTADO`) sem transação nem trava. Mantenha a transação curta: nada de chamada externa, push ou
  upload dentro dela.
- A apuração do sorteio é idempotente: trava a rodada, confere o estado e só então apura. Rodar
  duas vezes não gera ganhadores em dobro.
- **Isolamento do módulo:** o módulo conversa com o resto do backend só por módulos exportados
  (`NotificationsModule`) e pela tabela `user` (leitura de nome, `isActive` e token de push). Não
  acrescente campos a modelos existentes, salvo as relações inversas que o Prisma exige em `user`.
  Assim ele pode ser extraído para um serviço próprio no futuro, se precisar.
- Além das travas, mantenha os índices únicos da seção 5.1 como segunda barreira.

### 5.3 Apuração agendada

O projeto não usa `@nestjs/schedule`; use BullMQ.

- Crie uma fila nova (constante e `registerQueue` em `src/queue/queue.module.ts`) e um agendador
  com `upsertJobScheduler` (modelo em `src/analytics/services/analytics-journey.service.ts`, linhas
  76-96) que roda a cada poucos segundos.
- A cada execução, o processor delega a um serviço que: apura sorteios cujo encerramento já passou,
  encerra corridas e resgates vencidos ou esgotados, e dispara os lembretes pendentes.
- Um job periódico que consulta o banco é preferível a um job com atraso por rodada: continua
  correto se o painel mudar o horário ou se o servidor reiniciar.
- O processor só delega. Intervalo e demais constantes ficam em `src/associado-sorte/config/`.

### 5.4 Rotas do app — `/api/associado-sorte`, `JwtAuthGuard`, base por `@BaseOrigin()`

| Rota | Função |
|---|---|
| `GET resumo` | Tudo que a tela inicial precisa em uma chamada: `ativa`, `serverNow`, saldo, estado do crédito diário (fonte, disponível hoje, sequência, próximo marco), rodadas abertas e próximas com a fase calculada e a situação do próprio associado, prêmios dele pendentes, últimos ganhadores, WhatsApp de suporte. Com a promoção desligada, devolve só `{ ativa: false }`. |
| `POST credito-diario/coletar` | Coleta do dia (seção 4.2). |
| `GET rodadas/:id` | Detalhe da rodada e do prêmio. |
| `POST rodadas/:id/participar` | Inscrição em sorteio (`bilhetes`). |
| `POST rodadas/:id/resgatar` | Resgate em corrida ou vitrine. Devolve o ganhador criado. |
| `POST` e `DELETE rodadas/:id/lembrete` | Liga e desliga o "Avise-me". |
| `GET extrato` | Lançamentos paginados. |
| `GET meus-premios`, `GET meus-premios/:id` | Prêmios do associado, com código e situação. |
| `PATCH meus-premios/:id/contato` | Confirma o WhatsApp de contato. |
| `GET regulamento` | Texto e data de atualização. |

Toda resposta com horário inclui `serverNow` em ISO, para o cronômetro do app.

### 5.5 Rotas do painel — `/api/admin/associado-sorte`

`@UseGuards(JwtAuthGuard, AdminPanelRoleGuard)` e `@AdminPanelRoles(AdminPanelRole.MARKETING)`,
exatamente como em `direct-partners-admin.controller.ts` (linhas 53-58). Reutilize o perfil
`MARKETING`; não crie perfil novo. Declare rotas fixas antes de `:id`.

- `GET opcoes` — bases (`TENANT.baseNames`) e rótulos dos enums.
- `GET dashboard` — indicadores por base: coletas de hoje, associados com saldo, créditos
  distribuídos e gastos, próximas rodadas, prêmios com estoque baixo, ganhadores aguardando contato.
- `GET` e `PUT config/:baseOrigin`.
- `premios` — listar, criar, detalhar, editar, excluir (lógico), `POST :id/imagem` (multipart),
  `POST :id/estoque` (entrada ou ajuste, com motivo), `GET :id/estoque/movimentos`.
- `rodadas` — listar com filtros (período, estado, mecânica, base), criar, detalhar, editar,
  `POST :id/publicar`, `POST :id/cancelar`, `POST :id/duplicar` (`semanas`),
  `GET :id/participantes`, `POST :id/apurar` (apuração manual, idempotente, para contingência).
- `ganhadores` — listar com filtros, `PATCH :id` (situação, observação, devolver ao estoque).
- `associados` — buscar por nome ou CPF com saldo, `GET :userId/extrato`,
  `POST :userId/creditos` (ajuste manual).

Listas paginadas devolvem `{ data, meta: { page, limit, total, totalPages } }`, como em
direct-partners.

### 5.6 Demais pontos

- **Erros:** objeto com `code`, no padrão dos helpers `erro422` / `erro409` de direct-partners.
  Códigos: 409 `RODADA_NAO_ABERTA`, `RODADA_ENCERRADA`, `ESGOTADO`, `JA_PARTICIPANDO`, `JA_GANHOU`,
  `EM_CARENCIA`; 422 `CREDITOS_INSUFICIENTES`, `ESTOQUE_INSUFICIENTE`, `PERIODO_INVALIDO`,
  `BASE_INVALIDA`, `FAIXAS_INVALIDAS`; 403 `PROMOCAO_INATIVA`.
- **Imagem do prêmio:** acrescente um método ao `FileUploadService` no molde de
  `uploadDirectPartnerLogo` (sharp, WebP, caminho `/uploads/associado-sorte/...`).
- **Analytics:** acrescente a `src/analytics/constants/analytics-allowlists.ts` as telas
  `screen_associado_sorte`, `screen_associado_sorte_rodada`, `screen_associado_sorte_premio` e as
  ações `sorte_credito_diario_coletado`, `sorte_participar_success`, `sorte_participar_error`,
  `sorte_resgatar_success`, `sorte_resgatar_error`, `sorte_whatsapp_aberto`.
- **Logs** em português com `baseTag(baseOrigin)`. Nunca registre CPF ou telefone completos.
- **Dados de demonstração:** crie `prisma/seed-associado-sorte-demo.ts` com um script npm próprio,
  idempotente, que se recusa a rodar com `NODE_ENV=production`. Ele ativa a promoção nas duas bases
  e cria alguns prêmios e rodadas das três mecânicas (uma abrindo em poucos minutos, uma aberta,
  uma encerrada com ganhador), para o marketing ver a tela preenchida. Não altere `prisma/seed.ts`.
- **Testes:** specs de serviço com repository mockado, no molde de
  `src/direct-partners/services/direct-partner-redemptions.service.spec.ts`. Cubra: coleta diária
  (idempotência, sequência, sorteio por peso com aleatório mockado); resgate (sucesso, esgotado,
  crédito insuficiente, já ganhou, rodada não aberta, carência); apuração (ganhadores distintos,
  peso por bilhete, sem inscritos, idempotência); cancelamento com estorno.
- **Documentação:** `docs/ASSOCIADO_DA_SORTE.md` (regras, rotas, códigos de erro, decisões) e uma
  linha na seção "Domínios" do `CLAUDE.md`.
- `npm run verify` precisa passar.

## 6. Fase 2 — Painel web em `/home/samuel/Documentos/AdminSorte/`

Aplicação **React** salva exatamente nessa pasta. Use a mesma stack do painel de referência, para
que as telas possam ser incorporadas a ele depois: Vite, React 18, TypeScript, Tailwind,
shadcn/ui, `react-router-dom` v6, TanStack Query v5, axios, `react-hook-form` + zod, `sonner` e
`lucide-react`. Consulte o painel de referência para ver como ele resolve login, cliente HTTP e
proteção de rotas; não copie a identidade visual dele (azul, "SafeGuard").

- **Login:** `POST /admin-panel/auth/login` com `{ email, password }`, que devolve
  `{ access_token, user: { id, name, email, role } }`. Envie `Authorization: Bearer <token>` nas
  demais chamadas. Só entram os perfis `MARKETING` e `ADMIN`; para os outros, mostre que não há
  permissão. Em 401, limpe a sessão e volte ao login.
- **Ambiente:** `VITE_API_URL` (já com `/api`; padrão local `http://localhost:3001/api`) e
  `VITE_UPLOADS_BASE_URL` opcional para as imagens em `/uploads`. Inclua `.env.example`. O CORS do
  backend aceita qualquer origem, mas só os headers `Content-Type` e `Authorization`. Use uma porta
  de desenvolvimento diferente de 8080, que é a do painel de referência.
- **Identidade Mais Prime:** preto `#141414`, vermelho de ação `#D9251C`, fundo `#F6F5F4`, cards
  brancos, títulos em Space Grotesk. Copie os logos de `AppAssociado/assets/logo-mais-prime.png`
  (para fundo escuro) e `logo-mais-prime2.png` (para fundo claro).
- **Seletor de base** no topo, alimentado por `GET opcoes`. Indicadores, configuração e filtros
  seguem a base selecionada.

Telas:

1. **Visão geral** — indicadores do `dashboard`, próximas rodadas, alertas de estoque baixo e de
   ganhadores aguardando contato.
2. **Prêmios** — lista com foto e estoque; formulário com upload de imagem; entrada e ajuste de
   estoque com motivo; histórico de movimentações.
3. **Agenda de rodadas** — visão por semana e lista com filtros. O formulário muda conforme a
   mecânica (bilhetes máximos só em sorteio; modo do crédito travado em "consome" na vitrine).
   Ações: publicar, cancelar, repetir semanalmente, ver inscritos, ver resultado.
4. **Créditos** — fonte do crédito diário; editor das faixas da raspadinha mostrando a
   probabilidade resultante de cada faixa e a média de créditos por dia; valor do check-in; marcos
   de sequência.
5. **Ganhadores** — filtros por situação, rodada e período; código do prêmio; botão "Chamar no
   WhatsApp" (wa.me com mensagem pronta); mudança de situação com observação; cancelamento com a
   opção de devolver ao estoque.
6. **Associados** — busca por nome ou CPF; saldo; extrato; ajuste manual com motivo.
7. **Configurações** — ligar e desligar a promoção na base, título e subtítulo, regulamento,
   WhatsApp de suporte, exibir ganhadores, carência.

Cuidados: datas e horas são sempre digitadas e exibidas em horário de Brasília e enviadas em ISO
com offset. Ações destrutivas (cancelar rodada, cancelar ganhador, ajuste negativo) pedem
confirmação. Toda tela trata carregamento, lista vazia e erro. Entregue um `README.md` com como
rodar e configurar.

## 7. Fase 3 — App

### 7.1 Rotas e entradas

- Tela principal em `app/(tabs)/associado-da-sorte.tsx`, registrada com `<Drawer.Screen>` em
  `app/(tabs)/_layout.tsx`. Ficar dentro do Drawer faz a tela herdar os bloqueios de sessão,
  primeiro login e revistoria.
- Subtelas em `app/associado-da-sorte/` com `_layout.tsx` (Stack, modelo
  `app/revistoria/_layout.tsx`): `rodada/[id].tsx`, `premio/[id].tsx`, `meus-premios.tsx`,
  `extrato.tsx`, `regulamento.tsx`. É o mesmo arranjo de `app/(tabs)/beneficios.tsx` com
  `app/beneficios/*`. Inclua a rota em `CLUBE_ROTAS` (`app/_layout.tsx`, linha 153) para ganhar a
  mesma transição. Essas subtelas ficam fora do Drawer e não herdam os bloqueios: cada uma deve
  lidar com sessão ausente, porque podem ser abertas direto por push.
- Entradas: um card de destaque na home (no estilo do `fuelCardPremium` de `app/(tabs)/index.tsx`),
  um item em `components/ui/drawer-content.tsx` e um em `app/(tabs)/menu.tsx`. Todas passam por
  `abrirComVeiculoAtivo`. As entradas só aparecem quando `resumo.ativa` é verdadeiro; se a consulta
  falhar, ficam escondidas.

### 7.2 Tela principal

De cima para baixo:

1. **Saldo de créditos** e sequência de dias, com atalhos para extrato e regulamento.
2. **Crédito diário:** a raspadinha ou o check-in de hoje. Se já coletou, mostra quanto ganhou e
   quando libera a próxima.
3. **Aviso "Você ganhou"** quando houver prêmio aguardando contato, levando à tela do prêmio.
4. **Rodadas:** abertas agora e próximas, com foto, mecânica, custo, unidades e cronômetro.
5. **Últimos ganhadores**, se a base exibir.

### 7.3 Raspadinha

- O valor vem do servidor. Chame `coletar` quando o associado começar a raspar e revele o valor
  recebido. Se ele sair no meio, o crédito já foi dado; ao voltar, a tela mostra o resultado do dia.
- Construa a superfície de raspar com `react-native-gesture-handler`, `react-native-reanimated` e
  `react-native-svg`, sem dependência nova. Ao passar de cerca de metade da área raspada, revele o
  restante sozinho.
- Use `expo-haptics` ao revelar. Com "Reduzir movimento" ligado, ofereça "Toque para revelar".
- Se `coletar` falhar, a raspadinha volta ao estado inicial com a mensagem de erro; não mostre um
  valor que o servidor não confirmou.

### 7.4 Cronômetro e rodadas

- Calcule a diferença entre `serverNow` e o relógio do aparelho uma vez por resposta e conte a
  partir do horário do servidor.
- Atualize o texto por um temporizador de um segundo. **Não use animação em loop**: as regras em
  `lib/moti-presets.ts` proíbem `loop` (derruba o app no Android ao trocar o tema).
- Ao zerar, refaça a consulta. Em sorteio, mostre "Apurando resultado" e consulte de novo a cada
  poucos segundos até a fase mudar.
- Detalhe da rodada por mecânica:
  - **SORTEIO:** escolher bilhetes (até o máximo), ver o custo total e confirmar; depois, "Você está
    participando com N bilhetes".
  - **CORRIDA:** botão desabilitado com o cronômetro até abrir; ao abrir, um toque resgata.
  - **RESGATE:** botão "Trocar por N créditos" com confirmação.
- Trate os erros 409 e 422 pelo `code`, com mensagem específica para cada um, no modelo do resgate
  de cupom em `components/beneficios/CupomSheet.tsx` (linhas 170-198). `ESGOTADO` na corrida é um
  desfecho normal, não um erro de sistema: escreva a mensagem nesse tom.
- Botão "Avise-me" nas rodadas ainda não abertas.

### 7.5 Tela do prêmio ("Você ganhou")

Foto e nome do prêmio, código, situação da entrega, campo para confirmar o WhatsApp e o botão
"Falar com a equipe" (abre o wa.me do suporte da base com a mensagem pronta). É o destino do push.
"Meus prêmios" lista todos.

### 7.6 Padrões obrigatórios do app

- HTTP só por `lib/api.ts` (`apiGet`, `apiPost`, `apiFetch`); não crie outro cliente. Funções em
  `endpoints/associado-sorte.ts`, hooks React Query em `hooks/use-associado-sorte.ts`, tipos em
  `types/associado-sorte.ts`, componentes em `components/sorte/`.
- Estilos com `useThemedStyles(makeStyles)` e tokens de `lib/theme.ts`. Nenhuma cor fixa em hex ou
  rgba. Títulos com `typography.family.heading*`. O objeto `clubeCard` copia as cores uma vez e não
  acompanha a troca de tema; não dependa dele em componentes novos.
- Reaproveite `ClubeHeader`, `ClubeLoading`, `ClubeEmpty`, `ClubeSectionHeader`, `PressableScale`,
  `Button`, `Skeleton`, o toast de `hooks/use-toast.ts` e os presets `enterUp` / `enterZoom`.
- Anime só `transform` e `opacity`.
- Analytics: `useScreenAnalytics` e `trackAction` com os nomes da seção 5.6, acrescentados também
  às allowlists de `services/analytics.ts` (fora da lista, o evento é descartado em silêncio).
- Tela de regulamento com o texto do painel e, ao final, um aviso fixo de que a promoção é de
  responsabilidade da Mais Prime e não tem patrocínio nem envolvimento da Apple ou do Google.
- Verificação: `npx tsc --noEmit` sem erros novos (o projeto não tem lint nem testes).

## 8. Fora do escopo

- Envio automático de WhatsApp por API.
- Outras fontes de crédito além de raspadinha, check-in e ajuste manual.
- Expiração de créditos, ranking, indicação de amigos.
- Perfil novo no painel; alterações no `protecto-admin-suite`.
- Push em massa de divulgação (o marketing já tem essa ferramenta no painel atual).
- Build nativo novo do app, publicação OTA, deploy.

## 9. Critérios de aceite

Demonstre cada item no ambiente local, com backend, painel e app rodando:

1. Pelo painel, com um usuário `MARKETING`: ativar a promoção numa base, cadastrar um prêmio com
   foto e estoque, e publicar uma rodada de cada mecânica.
2. No app, a entrada aparece só para a base com a promoção ativa e some ao desligar no painel.
3. A raspadinha credita uma vez por dia; uma segunda chamada no mesmo dia não credita de novo.
4. **Corrida:** antes da abertura o servidor recusa com `RODADA_NAO_ABERTA`. Com uma unidade e
   várias requisições simultâneas de usuários diferentes (faça um script que dispare em paralelo),
   exatamente uma vence, as outras recebem `ESGOTADO`, e o estoque cai exatamente uma unidade.
5. **Sorteio:** inscrições debitam os créditos; no encerramento a apuração acontece sozinha, cria
   os ganhadores e baixa o estoque; rodar a apuração de novo não muda nada.
6. **Vitrine:** a troca debita os créditos e baixa o estoque; sem saldo, responde
   `CREDITOS_INSUFICIENTES`.
7. Cancelar uma rodada com inscritos devolve os créditos, e o extrato mostra o estorno.
8. O ganhador recebe o push, o toque abre a tela do prêmio, e os botões de WhatsApp do app e do
   painel abrem a conversa com a mensagem pronta.
9. O painel mostra o ganhador, permite mudar a situação até "Entregue", e o histórico de estoque
   registra a saída.
10. `npm run verify` passa no backend; `npm run build` passa no painel; `npx tsc --noEmit` não tem
    erros novos no app.

Se não conseguir rodar alguma parte (por exemplo, o app num aparelho ou emulador), diga qual parte
ficou sem verificação em vez de dá-la como pronta.

## 10. Relatório final

Ao terminar, responda com:

- o que foi entregue em cada uma das três partes e como rodar cada uma;
- o resultado de cada critério de aceite, dizendo o que foi verificado de fato e como;
- a migration: se foi aplicada, e em qual banco;
- decisões que você tomou onde este documento deixava em aberto;
- o que ficou pendente ou diferente do pedido, e por quê.
