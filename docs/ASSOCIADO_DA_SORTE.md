# Associado da Sorte (v2)

Promoção da base **MAIS_PRIME** para associados inscritos no produto "Associado da Sorte" do SGA:
o associado **raspa uma raspadinha** para descobrir se ganhou um **voucher em créditos**
(1 crédito = R$ 1; créditos não expiram). Os vouchers saem de um **cronograma de momentos
premiados** importado de planilha e **travado** na publicação da campanha (auditoria). Os créditos
são gastos na **Loja da Sorte** (produtos com preço em créditos e estoque); cada compra avisa a
equipe pelo painel e por e-mail, e a equipe chama o associado no WhatsApp para a retirada.

Módulo: `src/associado-sorte/`. v2 de 13/11/2026 (visão do marketing), sobre o piloto de 12/11.
Especificação: [`ASSOCIADO_DA_SORTE_V2_PROMPT.md`](./ASSOCIADO_DA_SORTE_V2_PROMPT.md).

| Parte | Onde |
|---|---|
| Backend | `src/associado-sorte/` (este repositório) |
| Painel web | `/home/samuel/Documentos/AdminSorte/` |
| App | `AppAssociado` — aba e telas `associado-da-sorte` |

**Este documento é o contrato** para o painel e o app: rotas, tipos de request/response e erros.

---

## 1. Conceitos e modelos

| Conceito | Modelo | Observação |
|---|---|---|
| Configuração | `SorteConfig` | Uma linha por base. Sem linha gravada vale o padrão (promoção **desligada**). |
| Inscrição (cache do SGA) | `SorteInscricao` | PK `userId`: um associado = um participante. `fonte` `SGA` \| `MANUAL`. |
| Campanha | `SorteCampanha` | `RASCUNHO → PUBLICADA → ENCERRADA`. Só uma `PUBLICADA` por base. |
| Momento premiado | `SorteMomentoPremiado` | Voucher de `creditos` que sai para a 1ª raspada a partir de `liberaEm`. |
| Raspada | `SorteRaspada` | Histórico de todas as raspadas (`GANHOU` \| `NAO_GANHOU`), entra na auditoria. |
| Carteira e extrato | `SorteCarteira`, `SorteCreditoLancamento` | Extrato só acrescenta; saldo nunca negativo. |
| Produto da loja | `SortePremio` | `tipo`, `custoCreditos`, `naLoja`, `limitePorAssociado`, `instrucoesRetirada`, `ordem`, estoque com movimentos (`SorteEstoqueMovimento`). |
| Pedido / ganhador | `SorteGanhador` | Compra na loja (`origem: 'LOJA'`, `rodadaId: null`) ou ganhador de rodada do piloto. |
| Notificação do painel | `SorteNotificacaoAdmin` | `NOVA_RETIRADA`, `ESTOQUE_BAIXO`, `ESTOQUE_ESGOTADO`. |
| Tentativa que falhou | `SorteTentativa` | `RASPAR` \| `COMPRAR` \| `ACESSAR` + `codigo` do erro. Sem CPF/telefone. |
| Piloto (guardado) | `SorteRodada`, `SorteParticipacao`, `SorteLembrete`, `SorteColetaDiaria` | Rodadas atrás de `rodadasHabilitadas` (padrão `false`). `SorteColetaDiaria` não é mais escrita. |

## 2. Regras

### 2.1 Base e inscrição
- Só participa a base em `SORTE_BASES_CONTEMPLADAS = ['MAIS_PRIME']`
  (`src/associado-sorte/config/associado-sorte.config.ts`). Associado de outra base recebe
  `resumo = { ativa: false }` e as demais rotas respondem 403 `PROMOCAO_INATIVA`.
- **Inscrito** = pelo menos um veículo que permite acesso ao app (`veiculoPermiteAcesso`) com um
  produto cujo `codigo_produto` = `produtoSgaCodigo` (padrão `"3677"`) **e** `descricao` =
  `produtoSgaDescricao` (padrão `"ASSOCIADO DA SORTE"`; comparação sem acento, sem espaços nas
  pontas/duplicados e sem diferenciar maiúsculas) **e** `situacao` = `ATIVO`.
- Consulta: `GET {SGA}/associado/buscar/{cpf}` (veículos) → para cada veículo candidato,
  `BeneficiosVeiculoService.getBeneficiosVeiculo` (`produto-vinculado-veiculo`), parando no primeiro
  que tiver o produto. Um associado com dois veículos inscritos é **um** participante.
- Cache em `SorteInscricao`, válido por `inscricaoValidadeHoras` (padrão 6 h). SGA fora do ar: vale o
  último valor; se nunca houve verificação, `inscrito: false, motivo: 'VERIFICACAO_INDISPONIVEL'`
  (o app mostra "tente mais tarde"). Depois de uma falha, o mesmo associado só é reconsultado após
  60 s. CPF desconhecido no SGA (HTTP 404/406) = não inscrito.
- **Marcação manual** no painel (`fonte: 'MANUAL'`, com autor e motivo; inscrito `true` ou `false`)
  prevalece e **não chama o SGA** até ser desfeita (`DELETE inscricoes/:userId`, que reconsulta).
- Todas as rotas do app exigem inscrição (403 `NAO_INSCRITO`, com `motivo`), **exceto** `resumo`
  (devolve `inscrito`, `motivo` e o convite) e `regulamento`.
- Cadastro inativo (`user.isActive = false`): 403 `ASSOCIADO_INATIVO`; no `resumo`, `inscrito: false`.

### 2.2 Raspadinha
- **Regra definitiva (marketing, 16/11/2026):** o prêmio é **sempre um voucher** em créditos
  (vale-brinde, sem conversão em dinheiro), trocável por qualquer produto da Loja da Sorte, inclusive
  os cadastrados depois. Há **um voucher por dia** num horário sorteado e não divulgado; ganha o
  **primeiro associado apto que raspar no horário ou depois dele** (ex.: voucher das 15:00:00,
  raspada às 15:00:01 ganha). "Apto" = inscrito, com raspada disponível no dia e fora da carência
  (padrão 0 = sem carência). O horário nunca é exposto ao app.
- `raspadasPorDia` (≥ 1) e `intervaloMinimoMinutos` (≥ 0) no painel. Janela = **dia do calendário em
  America/Sao_Paulo** (offset fixo -03:00). Raspada não usada **não acumula**.
- O intervalo vale só entre raspadas do **mesmo dia**: a 1ª raspada de cada dia libera às 00:00.
- Transação (READ COMMITTED) de `POST raspar`:
  1. fora da transação: limite de requisições (10/min), acesso + inscrição, campanha publicada no
     período (`SEM_CAMPANHA` / `CAMPANHA_FORA_DO_PERIODO`);
  2. trava a **carteira**, conta as raspadas de hoje → `LIMITE_DIARIO` ou `INTERVALO` (com
     `proximaRaspadaEm`);
  3. jornada (se ligada e for a 1ª raspada do dia): atualiza a sequência e calcula o bônus;
  4. carência: ganhou voucher há menos de `carenciaDias` → `NAO_GANHOU` sem olhar momentos;
  5. reserva o momento **mais antigo com `liberaEm <= agora` e sem ganhador** com
     `FOR UPDATE SKIP LOCKED`;
  6. achou: grava a raspada `GANHOU`, marca o momento (`userId`, `ganhoEm`, `raspadaId`) e credita
     `VOUCHER_RASPADINHA`; não achou: raspada `NAO_GANHOU`. Bônus da jornada: `BONUS_SEQUENCIA`.
- **Um momento nunca sai antes de `liberaEm`**; sem ganhador, continua disponível nos dias
  seguintes. O mesmo associado pode ganhar vários vouchers (respeitando a carência).
- O resultado é decidido no servidor **antes** de o app animar a raspagem.

### 2.3 Jornada de check-in (opcional)
- `jornadaAtiva` (padrão `false`) + `marcosSequencia` (`[{ dias ≥ 2, bonus ≥ 1 }]`).
- O dia conta quando o associado faz ao menos uma raspada (ganhando ou não). Dias seguidos somam 1;
  pular um dia volta a 1; depois do maior marco, recomeça. No 1º dia de cada marco, a 1ª raspada
  credita o bônus, uma vez.
- Desligada: nenhum bônus e `jornada: null` no `resumo` e no `raspar`.

### 2.4 Campanha e cronograma
- Campanha: `baseOrigin`, `nome`, `inicio`, `fim` (instantes ISO), `estado`.
- **Planilha oficial** (`Associado-da-Sorte_Cronograma-vale-brinde.xlsx`, enviada em 16/11/2026),
  importada direto no painel (`xlsxBase64`):
  - aba **Cronograma**: 2 linhas de título, cabeçalho `Dia | Horário | Prêmio`, uma linha por dia
    (`14/12/2026 | 09:40:31 | Voucher R$120`). Período 14/12/2026 a 13/12/2027, 365 prêmios, horários
    entre 08:00:00 e 19:59:59 (Brasília), **com segundos**;
  - aba **Resumo**: `Prêmio | Descrição | Valor unitário (R$) | Quantidade | Valor total (R$)`
    (344 × R$ 120 + 21 × R$ 200 = R$ 45.480). O valor unitário define os créditos do prêmio, e
    quantidades/totais são conferidos contra o cronograma: divergência vira **aviso** na prévia (não
    bloqueia). Leitura em `helpers/sorte-cronograma-xlsx.helper.ts` (ExcelJS, com testes).
- CSV (alternativa): mesmas colunas (`Dia;Horário;Prêmio`) ou `data;hora;creditos;descricao`.
  Aliases: `data`/`dia`, `hora`/`horario`, `creditos`/`valor` (sem eles, os créditos saem do
  `premio`: "Voucher R$120" → 120; centavos são recusados), `descricao` (sem ela, vale o `premio`).
  `hora` `HH:MM` ou `HH:MM:SS`. Linhas de título antes do cabeçalho são ignoradas. Separador `;`,
  `,` ou tab, cabeçalho em qualquer ordem (sem diferenciar maiúsculas/acentos), aspas e BOM
  aceitos, linhas vazias ignoradas, até 20.000 linhas. Recusa: horário fora de `[inicio, fim]` e **linha duplicada**
  (mesmo horário + créditos + descrição, inclusive contra os momentos já gravados quando
  `substituir: false`). Parser isolado em `helpers/sorte-cronograma.helper.ts` (com testes).
  Exemplo: [`docs/exemplos/cronograma-exemplo.csv`](./exemplos/cronograma-exemplo.csv).
- Importar é **tudo ou nada**: com qualquer erro, 422 `CRONOGRAMA_INVALIDO` e nada é gravado.
  `substituir` (padrão `true`) troca todos os momentos do rascunho; `false` acrescenta.
- **Publicar** (exige `confirmacao` = nome da campanha, ≥ 1 momento, todos no período, `fim` no
  futuro, nenhuma outra publicada na base) grava o **SHA-256** do cronograma e **trava**: criar,
  editar ou apagar momento, importar CSV, mudar `inicio`/`fim`/`baseOrigin` e excluir respondem 409
  `CAMPANHA_TRAVADA`. Só o `nome` continua editável. Não existe "despublicar".
- **Encerrar** (motivo obrigatório) é permitido e fica registrado (`encerradaEm/Por`, motivo). O job
  encerra sozinho a campanha publicada cujo `fim` passou (autor "Sistema (fim do período)").
- **Hash**: SHA-256 (hex) do texto canônico, uma linha por item, separadas por `\n`:
  ```
  campanha=<id>
  base=<baseOrigin>
  inicio=<inicio ISO UTC>
  fim=<fim ISO UTC>
  <liberaEm ISO UTC>;<creditos>;<descricao (sem ; nem quebras)>   ← um por momento, ordem (liberaEm, id)
  ```
- **Auditoria** (`GET campanhas/:id/auditoria`): CSV `;`, UTF-8 com BOM, CRLF, horários
  `DD/MM/AAAA HH:MM:SS` de Brasília, em três blocos: (1) dados da campanha com
  `hash_cronograma_sha256`, `hash_recalculado_sha256` e `hash_confere` (`SIM`/`NAO`); (2)
  `MOMENTOS PREMIADOS` (`momento_id;libera_em;creditos;descricao;status;ganhador;cpf;raspada_id;hora_da_raspada`,
  CPF mascarado); (3) `RASPADAS` (`raspada_id;data_hora;associado;cpf;resultado;creditos;bonus_jornada;momento_id`).

### 2.5 Loja da Sorte
- Produto na loja = `naLoja && ativo && !excluído`; precisa de `custoCreditos ≥ 1` (422
  `CUSTO_INVALIDO`). Esgotados continuam na vitrine com `esgotado: true`. Ordem: `ordem`, `nome`.
- Compra: limite de requisições (20/10 s), acesso + inscrição, recusa rápida sem transação
  (`ESGOTADO`), semáforo (4 compras simultâneas por processo) e transação **prêmio → carteira**
  revalidando tudo: estoque (`ESGOTADO`), `limitePorAssociado` (0 = sem limite; pedidos cancelados
  não contam; `LIMITE_POR_ASSOCIADO`), saldo (`CREDITOS_INSUFICIENTES`). Registra o pedido
  (`SorteGanhador`, `origem: 'LOJA'`, código de 6 caracteres), baixa o estoque com movimento
  `SAIDA_GANHADOR`, debita `COMPRA_LOJA` e cria as notificações do painel.
- Serviços Mais Prime e cupons são ativados/entregues à mão pela equipe; o sistema só registra o pedido.
- Entrega/retirada: `AGUARDANDO_CONTATO → EM_CONTATO → ENTREGUE`, ou `CANCELADO` (definitivo, com
  devolução opcional de estoque e créditos) — rota `PATCH ganhadores/:id` do piloto.

### 2.6 Avisos para a equipe
- Cada compra cria, **na transação**, a notificação `NOVA_RETIRADA` e, se for o caso,
  `ESTOQUE_ESGOTADO` (estoque 0) ou `ESTOQUE_BAIXO` (estoque ≤ 3).
- **E-mail** para `emailNotificacoes` (um ou mais, separados por vírgula): job
  `sorte-email-retirada` na `ASSOCIADO_SORTE_QUEUE`, enfileirado **depois do commit**, 3 tentativas
  (espera exponencial de 30 s). Falha nunca desfaz a compra; o resultado fica na notificação
  (`email.situacao`: `PENDENTE` → `ENVIADO` \| `FALHOU`). Conteúdo: produto, tipo, código do pedido,
  créditos, nome, CPF mascarado, telefone mascarado (o confirmado pelo associado no app; na hora da
  compra normalmente "não informado") e, com `ASSOCIADO_SORTE_PAINEL_URL`, o botão "Abrir no
  painel" (`<url>/retiradas?busca=<código>`).
- **WhatsApp do marketing**: com `whatsappMarketing` preenchido, cada `NOVA_RETIRADA` traz
  `linkWhatsappMarketing` (wa.me com o resumo do pedido). Vazio: `null` (o painel esconde o botão).
- Push ao comprador depois do commit: "Pedido confirmado 🎁", `data: { type: 'internal_route', screen: 'associado-da-sorte/premio/<id>' }`.

### 2.7 Lembrete "Sua raspadinha está liberada"
- `lembretesAtivos` (padrão `true`), janela `lembreteInicio`–`lembreteFim` (padrão `08:00`–`21:00`,
  Brasília; `[inicio, fim)`, pode passar da meia-noite).
- A cada 5 s (passo isolado do ciclo): para cada **inscrito** (`SorteInscricao.inscrito = true`) com
  cadastro ativo e token de push, com raspada restante no dia e liberação já passada
  (`proximaRaspadaEm <= agora`) que ainda não foi avisada → push via `NOTIFICATION_QUEUE`
  (`addBulk`), `data: { type: 'internal_route', screen: 'associado-da-sorte' }`.
- Controle em `SorteCarteira.lembreteRaspadaEm` (liberação já avisada), reivindicado com update
  condicional antes de enfileirar: **nunca dois pushes para a mesma liberação**. Fora da janela
  ninguém é avisado; quando a janela abre, cada liberação pendente gera **um** push (sem acumular).
  O primeiro aviso do dia é a liberação da 00:00, entregue no início da janela.
- Lote por ciclo: `ASSOCIADO_SORTE_LEMBRETE_LOTE` (padrão 500); o resto sai no ciclo seguinte.
  Só recebe quem já tem `SorteInscricao` (o app verifica no primeiro acesso) e campanha no período.

### 2.8 Créditos
- Inteiros; saldo nunca negativo; toda alteração passa por `SorteCreditosService.lancar`.
- Tipos (`tipo` é `VARCHAR`): `VOUCHER_RASPADINHA`, `BONUS_SEQUENCIA`, `COMPRA_LOJA`,
  `AJUSTE_ADMIN`, `ESTORNO` (v2) e, do piloto, `RASPADINHA`, `CHECKIN`, `PARTICIPACAO_SORTEIO`, `RESGATE`.
- Não expiram.

### 2.9 Tentativas que falharam
- Gravadas sem bloquear a resposta no `catch` de `raspar` (`RASPAR`) e `comprar` (`COMPRAR`) e no 403
  `NAO_INSCRITO` das demais rotas (`ACESSAR`). `MUITAS_REQUISICOES` não é gravada.
- `contexto` só com chaves conhecidas (`premioId`, `campanhaId`, `saldo`, `necessario`,
  `proximaRaspadaEm`, `limitePorAssociado`, `motivo`, `rota`) — nunca CPF ou telefone.

### 2.10 O que saiu de cena (sem apagar código)
- Rodadas (SORTEIO/CORRIDA/RESGATE) e "Avise-me": atrás de `rodadasHabilitadas` (padrão `false`).
  As rotas de rodada do **app** respondem 404 com a flag desligada; as do **painel** continuam
  funcionando (o painel esconde o menu). O job continua apurando o que existir.
- `faixasRaspadinha`, `fonteCreditoDiario`, `creditosCheckin`: sem uso (ainda no `Config`, não exibir).
- `POST credito-diario/coletar` foi **removida** (404); `SorteColetaDiaria` fica no banco.

## 3. Concorrência

- Transação interativa (`SorteUnidadeTrabalho`) com `SELECT ... FOR UPDATE`, READ COMMITTED.
- Ordens de trava: **campanha** (escritas do painel); **carteira → momento** (raspar; o momento com
  `SKIP LOCKED`, nunca espera, então não forma ciclo); **prêmio → carteira** (loja e cancelamento);
  **rodada → prêmio → carteira** (piloto).
- Banco local: MariaDB 13.0.2 (`SKIP LOCKED` disponível desde 10.6). Produção precisa de MariaDB ≥
  10.6 ou MySQL ≥ 8.0.
- 10 raspadas simultâneas com 1 momento liberado → exatamente 1 ganhador (teste unitário e aceite).

## 4. Job periódico

Fila `ASSOCIADO_SORTE_QUEUE` (`associado-sorte`), agendador a cada 5 s. Cada passo isolado em
try/catch: apura sorteios vencidos, encerra corridas/vitrines, lembretes de rodada (piloto),
**encerra campanhas vencidas**, **lembretes de raspadinha**. O mesmo processor executa o job
`sorte-email-retirada`. O agendador é **desligado por padrão** (promoção ainda sem aval para produção): só roda com `ASSOCIADO_SORTE_AGENDADOR=true`; desligado, o boot remove o agendador que tenha ficado no Redis, sem log.

Variáveis opcionais: `ASSOCIADO_SORTE_PAINEL_URL` (link do e-mail), `ASSOCIADO_SORTE_LEMBRETE_LOTE`.

---

## 5. Rotas do app — `/api/associado-sorte` (`JwtAuthGuard`)

A base vem sempre do JWT. Datas em ISO UTC (`string`). `imagemUrl` é relativo
(`/uploads/associado-sorte/...`). Toda resposta com horário traz `serverNow` (relógio do servidor
para o cronômetro).

| Rota | Inscrição? | Resposta |
|---|---|---|
| `GET resumo` | não | `Resumo` |
| `POST raspar` | sim | `RaspadaResultado` |
| `GET loja` | sim | `{ serverNow, saldo: number, produtos: ProdutoLoja[] }` |
| `POST loja/:premioId/comprar` | sim | `{ serverNow, pedido: MeuPremio, saldo: number }` |
| `GET extrato?page&limit(≤100)` | sim | `{ serverNow, saldo, data: Lancamento[], meta: Meta }` |
| `GET meus-premios` | sim | `{ serverNow, data: MeuPremio[] }` |
| `GET meus-premios/:id` | sim | `{ serverNow, premio: MeuPremio }` |
| `PATCH meus-premios/:id/contato` `{ telefone: string }` | sim | `{ serverNow, premio: MeuPremio }` |
| `GET regulamento` | não | `{ titulo: string, regulamento: string, atualizadoEm: string \| null }` |
| `GET rodadas/:id`, `POST rodadas/:id/participar`, `POST rodadas/:id/resgatar`, `POST`/`DELETE rodadas/:id/lembrete` | sim | **404** com `rodadasHabilitadas = false`; ligada, contrato do piloto (seção 9) |

```ts
type ISO = string;
type Meta = { page: number; limit: number; total: number; totalPages: number };
type Marco = { dias: number; bonus: number };
type MotivoNaoInscrito = 'NAO_INSCRITO' | 'VERIFICACAO_INDISPONIVEL';

// ------------------------------------------------------------------ resumo
type Resumo = ResumoInativo | ResumoNaoInscrito | ResumoInscrito;

interface ResumoInativo {            // base fora da promoção ou promoção desligada
  ativa: false;
  serverNow: ISO;
}

interface Convite {
  whatsapp: string | null;           // dígitos com DDI (ex.: "5521999998888"); null = não configurado
  mensagem: string;
  link: string | null;               // "https://wa.me/<whatsapp>?text=<mensagem codificada>"; null sem número
}

interface ResumoBase {
  ativa: true;
  serverNow: ISO;
  titulo: string;
  subtitulo: string | null;
  convite: Convite;
  saldo: number;
  totalGanho: number;
  whatsappSuporte: string | null;
}

interface ResumoNaoInscrito extends ResumoBase {
  inscrito: false;
  motivo: MotivoNaoInscrito;         // VERIFICACAO_INDISPONIVEL → "tente mais tarde" (não abrir o convite)
  raspadinha: null;
  jornada: null;
  campanha: null;
  premiosPendentes: [];
  rodadasHabilitadas: false;
  rodadas: [];
}

interface ResumoInscrito extends ResumoBase {
  inscrito: true;
  motivo: null;
  raspadinha: EstadoRaspadinha;
  jornada: Jornada | null;           // null com a jornada desligada
  campanha: CampanhaApp | null;      // null = nenhuma campanha publicada
  premiosPendentes: MeuPremio[];     // AGUARDANDO_CONTATO ou EM_CONTATO
  rodadasHabilitadas: boolean;
  rodadas: Rodada[];                 // vazio com a flag desligada (tipo Rodada: seção 9)
}

interface EstadoRaspadinha {
  raspadasPorDia: number;
  intervaloMinimoMinutos: number;
  raspadasHoje: number;
  raspadasRestantesHoje: number;
  proximaRaspadaEm: ISO;             // <= serverNow: liberada; sem restantes: próxima 00:00 de Brasília
  bloqueio: 'LIMITE_DIARIO' | 'INTERVALO' | null;
  disponivel: boolean;               // pode raspar agora (campanha no período e sem bloqueio)
  indisponivelMotivo: 'SEM_CAMPANHA' | 'CAMPANHA_FORA_DO_PERIODO' | 'LIMITE_DIARIO' | 'INTERVALO' | null;
}

interface Jornada {
  sequencia: number;                 // dias seguidos vigentes (0 se pulou um dia)
  proximoMarco: (Marco & { faltam: number }) | null;
  marcos: Marco[];
}

interface CampanhaApp { id: number; nome: string; inicio: ISO; fim: ISO; noPeriodo: boolean }

// ------------------------------------------------------------------ raspar
interface RaspadaResultado {
  serverNow: ISO;
  raspadaId: number;
  resultado: 'GANHOU' | 'NAO_GANHOU';
  creditos: number;                  // voucher (0 quando não ganhou)
  bonusJornada: number;              // bônus da jornada creditado nesta raspada (0 sem marco)
  saldo: number;                     // já com voucher e bônus
  raspadasRestantesHoje: number;
  proximaRaspadaEm: ISO;
  voucher: { momentoId: number; descricao: string | null } | null;
  jornada: Jornada | null;
}

// -------------------------------------------------------------------- loja
type TipoProduto = 'FISICO' | 'SERVICO_MAIS_PRIME' | 'CUPOM_PARCEIRO';

interface ProdutoLoja {
  id: number;
  nome: string;
  descricao: string | null;
  imagemUrl: string | null;
  tipo: TipoProduto;
  custoCreditos: number;
  estoque: number;
  esgotado: boolean;
  ultimasUnidades: boolean;          // estoque entre 1 e 3
  limitePorAssociado: number;        // 0 = sem limite
  minhasCompras: number;             // pedidos não cancelados deste associado
  atingiuLimite: boolean;
}

// ----------------------------------------------------- pedidos e prêmios
type Situacao = 'AGUARDANDO_CONTATO' | 'EM_CONTATO' | 'ENTREGUE' | 'CANCELADO';
type Origem = 'LOJA' | 'SORTEIO' | 'CORRIDA' | 'RESGATE';

interface MeuPremio {
  id: number;                        // id do pedido (push: screen 'associado-da-sorte/premio/<id>')
  codigo: string;                    // 6 caracteres, sem 0/O/1/I/L ("código do pedido")
  situacao: Situacao;
  origem: Origem;
  ganhouEm: ISO;                     // data da compra/vitória
  entregueEm: ISO | null;
  telefoneContato: string | null;
  telefoneConfirmado: boolean;
  premio: { id: number; nome: string; descricao: string | null; imagemUrl: string | null; tipo: TipoProduto };
  rodada: { id: number; titulo: string; mecanica: 'SORTEIO' | 'CORRIDA' | 'RESGATE' } | null; // null na loja
  instrucoesRetirada: string | null; // mostrar na tela de sucesso e no detalhe
  whatsappSuporte: string | null;
  linkWhatsappSuporte: string | null; // wa.me do suporte com produto + código
}

interface Lancamento {
  id: number;
  tipo: string;                      // VOUCHER_RASPADINHA | BONUS_SEQUENCIA | COMPRA_LOJA | AJUSTE_ADMIN | ESTORNO | (piloto)
  rotulo: string;                    // "Voucher da raspadinha", "Compra na Loja da Sorte"...
  valor: number;                     // com sinal
  saldoApos: number;
  descricao: string | null;
  rodadaId: number | null;
  criadoEm: ISO;
}
```

Erros típicos de `POST raspar`: 403 `NAO_INSCRITO` / `PROMOCAO_INATIVA` / `ASSOCIADO_INATIVO`;
409 `SEM_CAMPANHA`, `CAMPANHA_FORA_DO_PERIODO` (`inicio`, `fim`, `serverNow`), `LIMITE_DIARIO` e
`INTERVALO` (ambos com `proximaRaspadaEm` e `serverNow`); 429; 503.
De `POST loja/:premioId/comprar`: 404 (produto fora da loja), 409 `ESGOTADO`,
409 `LIMITE_POR_ASSOCIADO` (`limitePorAssociado`), 422 `CREDITOS_INSUFICIENTES` (`saldo`,
`necessario`), 429, 503.

## 6. Rotas do painel — `/api/admin/associado-sorte`

`JwtAuthGuard` + `AdminPanelRoleGuard` + `@AdminPanelRoles(MARKETING)` (ADMIN sempre passa). Login:
`POST /api/admin-panel/auth/login`. Listas paginadas: `{ data, meta: Meta }` (`limit` ≤ 100, salvo
indicação). A base da operação vem na rota/consulta.

### 6.1 Geral e configuração
| Rota | Função |
|---|---|
| `GET opcoes` | `Opcoes` |
| `GET dashboard?baseOrigin=` | `Dashboard` |
| `GET config/:baseOrigin` | `Config` |
| `PUT config/:baseOrigin` | Corpo **parcial** de `ConfigEntrada` (o que não vier fica) → `Config` |

```ts
type Opcao = { value: string; label: string };
interface Opcoes {
  bases: Opcao[]; basesContempladas: string[];
  tiposProduto: Opcao[]; origensGanhador: Opcao[]; estadosCampanha: Opcao[]; statusMomento: Opcao[];
  resultadosRaspada: Opcao[]; fontesInscricao: Opcao[]; acoesTentativa: Opcao[]; tiposNotificacao: Opcao[];
  situacoesGanhador: Opcao[]; tiposMovimentoEstoque: Opcao[]; tiposLancamento: Opcao[];
  mecanicas: Opcao[]; modosCredito: Opcao[]; estados: Opcao[]; fases: Opcao[]; fontesCredito: Opcao[]; // piloto
  estoqueBaixo: number;              // 3
}

interface Config {
  baseOrigin: string; ativa: boolean; titulo: string; subtitulo: string | null;
  regulamento: string | null; regulamentoAtualizadoEm: ISO | null;
  whatsappSuporte: string | null;
  carenciaDias: number;              // dias sem poder ganhar voucher de novo (0 desliga)
  // inscrição
  produtoSgaCodigo: string;          // "3677"
  produtoSgaDescricao: string;       // "ASSOCIADO DA SORTE"
  inscricaoValidadeHoras: number;    // 6 (1–720)
  // raspadinha
  raspadasPorDia: number;            // 1–100
  intervaloMinimoMinutos: number;    // 0–1440
  // jornada
  jornadaAtiva: boolean;
  marcosSequencia: Marco[];          // dias ≥ 2, bonus ≥ 1, sem dias repetidos
  // lembretes
  lembretesAtivos: boolean; lembreteInicio: string; lembreteFim: string;   // "HH:MM"
  // convite (não inscrito)
  whatsappConvite: string | null; mensagemConvite: string;
  // notificações da equipe
  emailNotificacoes: string;         // "a@x.com, b@y.com"
  whatsappMarketing: string | null;
  rodadasHabilitadas: boolean;
  // legado do piloto (não exibir)
  fonteCreditoDiario: 'RASPADINHA' | 'CHECKIN' | 'NENHUMA';
  faixasRaspadinha: { creditos: number; peso: number }[];
  creditosCheckin: number; exibirGanhadores: boolean;
  atualizadoEm: ISO | null;
}
// Entrada do PUT: os mesmos campos (sem baseOrigin/regulamentoAtualizadoEm/atualizadoEm), todos opcionais.
// Telefones aceitam "(21) 99999-8888" e são gravados "5521999998888"; "" ou null removem.
// emailNotificacoes: separados por vírgula ou ; — inválido → 422 EMAIL_INVALIDO.

interface Dashboard {
  serverNow: ISO; baseOrigin: string; promocaoAtiva: boolean; baseContemplada: boolean; rodadasHabilitadas: boolean;
  raspadasHoje: number; vouchersHoje: number; inscritos: number;
  campanha: CampanhaAdmin | null;    // publicada da base
  vouchersSaidos: number;            // momentos ganhos
  vouchersPendentes: number;         // liberados e sem ganhador
  vouchersAguardando: number;        // ainda não chegaram no horário
  creditosEmCirculacao: number;      // soma dos saldos da base
  notificacoesNaoLidas: number;
  retiradasAguardandoContato: number;
  // piloto (mantidos)
  fonteCreditoDiario: string; associadosComSaldo: number; creditosDistribuidos: number; creditosGastos: number;
  proximasRodadas: RodadaAdmin[]; premiosEstoqueBaixo: PremioAdmin[];
  ganhadoresAguardandoContato: number; ganhadoresAguardando: GanhadorAdmin[];
}
```

### 6.2 Campanhas e momentos
| Rota | Função |
|---|---|
| `GET campanhas?baseOrigin&estado&page&limit` | `{ serverNow, data: CampanhaAdmin[], meta }` |
| `POST campanhas` `{ baseOrigin, nome, inicio, fim }` | 201 → `CampanhaAdmin & { serverNow }` (rascunho) |
| `GET campanhas/:id` | `CampanhaAdmin & { serverNow }` |
| `PATCH campanhas/:id` `{ nome?, inicio?, fim?, baseOrigin? }` | → `CampanhaAdmin & { serverNow }`. Publicada/encerrada: só `nome` |
| `DELETE campanhas/:id` | 204 (só rascunho) |
| `POST campanhas/:id/cronograma/pre-visualizar` `{ xlsxBase64 \| csv, substituir? }` | `PreVisualizacao` (não grava) |
| `POST campanhas/:id/cronograma/importar` `{ xlsxBase64 \| csv, substituir? }` | `{ campanhaId, criados, removidos, campanha: CampanhaAdmin }` |
| `GET campanhas/:id/momentos?status&page&limit(≤500, padrão 100)` | `{ serverNow, data: MomentoAdmin[], meta }` (ordem de `liberaEm`) |
| `POST campanhas/:id/momentos` `{ liberaEm, creditos, descricao? }` | 201 → `CampanhaAdmin & { serverNow }` |
| `PATCH campanhas/:id/momentos/:momentoId` (parcial) | → `CampanhaAdmin & { serverNow }` |
| `DELETE campanhas/:id/momentos/:momentoId` | 204 |
| `POST campanhas/:id/publicar` `{ confirmacao }` | → `CampanhaAdmin & { serverNow }` |
| `POST campanhas/:id/encerrar` `{ motivo }` | → `CampanhaAdmin & { serverNow }` |
| `GET campanhas/:id/auditoria` | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="auditoria-campanha-<id>.csv"` |

```ts
interface CampanhaAdmin {
  id: number; baseOrigin: string; nome: string; inicio: ISO; fim: ISO;
  estado: 'RASCUNHO' | 'PUBLICADA' | 'ENCERRADA';
  travada: boolean;                  // estado !== RASCUNHO
  publicadaEm: ISO | null; publicadaPor: string | null; hashCronograma: string | null; // SHA-256 hex
  encerradaEm: ISO | null; encerradaPor: string | null; motivoEncerramento: string | null;
  momentos: { total: number; ganhos: number; disponiveis: number; aguardando: number; creditosTotal: number; creditosGanhos: number };
  criadoEm: ISO; atualizadoEm: ISO;
}

type StatusMomento = 'AGUARDANDO' | 'DISPONIVEL' | 'GANHO'; // aguardando horário / liberado sem ganhador / ganho
interface MomentoAdmin {
  id: number; liberaEm: ISO; creditos: number; descricao: string | null; status: StatusMomento;
  ganhador: { id: number; nome: string; cpfMascarado: string } | null;
  ganhoEm: ISO | null; raspadaId: number | null; raspadaEm: ISO | null;
}

interface PreVisualizacao {
  formato: 'xlsx' | 'csv';
  aba: string;                 // aba lida ('' no CSV)
  titulo: string[];            // linhas de título acima do cabeçalho
  resumo: { premio: string; descricao: string | null; valorUnitario: number | null;
            quantidadeDeclarada: number | null; valorTotalDeclarado: number | null;
            quantidadeNoCronograma: number; valorTotalNoCronograma: number }[];
  avisos: string[];            // divergências Resumo × Cronograma (não bloqueiam)
  periodoDoArquivo: { primeiro: ISO; ultimo: ISO } | null;
  campanhaId: number; travada: boolean; substituir: boolean;
  totalLinhas: number; validas: number; totalCreditos: number;
  linhas: { linha: number; liberaEm: ISO; creditos: number; descricao: string | null }[];
  erros: { linha: number; mensagem: string }[];   // número da linha no arquivo/planilha
}
```
Importar com erro → 422 `{ code: 'CRONOGRAMA_INVALIDO', message, erros: { linha, mensagem }[] }` (até 500 erros).

### 6.3 Loja (produtos = prêmios)
| Rota | Função |
|---|---|
| `GET premios?page&limit&busca&ativo&naLoja&tipo` | `{ data: PremioAdmin[], meta }` |
| `POST premios` | `ProdutoEntrada` → 201 `PremioAdmin` |
| `GET premios/:id` / `PATCH premios/:id` (parcial de `ProdutoEntrada`, sem `estoqueInicial`) / `DELETE premios/:id` | `PremioAdmin` / `PremioAdmin` / 204 (409 `PREMIO_EM_USO` com rodada publicada) |
| `POST premios/:id/imagem` | multipart, campo `imagem` (JPG/PNG/WebP ≤ 5 MB) → `PremioAdmin` |
| `POST premios/:id/estoque` `{ tipo: 'ENTRADA' \| 'AJUSTE', quantidade, motivo }` | `PremioAdmin` (AJUSTE com sinal) |
| `GET premios/:id/estoque/movimentos` | `{ data: { id, tipo, quantidade, estoqueApos, motivo, rodadaId, ganhadorId, autor, criadoEm }[], meta }` |

```ts
interface ProdutoEntrada {
  nome: string;                       // ≤ 120
  descricao?: string | null;          // ≤ 2000
  valorEstimado?: number | null;      // R$
  estoqueInicial?: number;            // só no POST (gera ENTRADA)
  ativo?: boolean;                    // padrão true
  tipo?: TipoProduto;                 // padrão FISICO
  custoCreditos?: number;             // ≥ 1 quando naLoja (422 CUSTO_INVALIDO)
  naLoja?: boolean;                   // padrão false
  limitePorAssociado?: number;        // 0 = sem limite
  instrucoesRetirada?: string | null; // ≤ 2000
  ordem?: number;                     // menor primeiro
}
interface PremioAdmin {
  id: number; nome: string; descricao: string | null; imagemUrl: string | null; valorEstimado: number | null;
  estoque: number; reservado: number; disponivel: number; ativo: boolean;
  tipo: TipoProduto; custoCreditos: number; naLoja: boolean; limitePorAssociado: number;
  instrucoesRetirada: string | null; ordem: number; criadoEm: ISO; atualizadoEm: ISO;
}
```
Produtos continuam editáveis com campanha publicada.

### 6.4 Retiradas (ganhadores/pedidos)
| Rota | Função |
|---|---|
| `GET ganhadores?page&limit&situacao&origem&rodadaId&baseOrigin&de&ate&busca` | `{ data: GanhadorAdmin[], meta }` (`busca`: código ou nome) |
| `PATCH ganhadores/:id` `{ situacao?, observacao?, devolverAoEstoque?, estornarCreditos? }` | `GanhadorAdmin` (as duas últimas só ao cancelar) |

```ts
interface GanhadorAdmin {
  id: number; codigo: string; situacao: Situacao; origem: Origem; baseOrigin: string;
  telefoneContato: string | null; telefoneConfirmadoEm: ISO | null;
  linkWhatsapp: string | null;        // wa.me para o associado (null até ele confirmar o número no app)
  observacao: string | null; creditosGastos: number; estoqueDevolvido: boolean;
  associado: { id: number; nome: string; cpfMascarado: string };
  premio: { id: number; nome: string; imagemUrl: string | null; tipo: TipoProduto };
  rodada: { id: number; titulo: string; mecanica: string; abertura: ISO } | null; // null na loja
  ganhouEm: ISO; entregueEm: ISO | null; canceladoEm: ISO | null;
}
```

### 6.5 Notificações
| Rota | Função |
|---|---|
| `GET notificacoes?lida=true\|false&tipo&baseOrigin&page&limit` | `{ data: NotificacaoAdmin[], meta }` (mais recentes primeiro) |
| `GET notificacoes/nao-lidas?baseOrigin` | `{ naoLidas: number }` (contador do menu; o painel consulta a cada 30 s) |
| `POST notificacoes/:id/lida` | `NotificacaoAdmin` |
| `POST notificacoes/marcar-todas-lidas?baseOrigin` | `{ marcadas: number }` |

```ts
interface NotificacaoAdmin {
  id: number; baseOrigin: string;
  tipo: 'NOVA_RETIRADA' | 'ESTOQUE_BAIXO' | 'ESTOQUE_ESGOTADO';
  titulo: string; mensagem: string;
  ganhadorId: number | null;          // link para a retirada (GET ganhadores?busca=<código>)
  premioId: number | null;
  lida: boolean; lidaEm: ISO | null; lidaPor: string | null;
  linkWhatsappMarketing: string | null; // botão "Enviar no WhatsApp do marketing" (só NOVA_RETIRADA com número configurado)
  email: { destinatarios: string[]; situacao: 'PENDENTE' | 'ENVIADO' | 'FALHOU'; enviadoEm: ISO | null; erro: string | null } | null;
  criadoEm: ISO;
}
```

### 6.6 Inscrições e associados
| Rota | Função |
|---|---|
| `GET inscricoes?busca&baseOrigin&inscrito=true\|false&fonte&page&limit` | `{ data: InscricaoAdmin[], meta }` — lista de participantes (um por associado) |
| `POST inscricoes/:userId/reverificar` | `{ userId, inscricao: Inscricao \| null, situacao: Situacao, sga: Situacao \| null }` |
| `PUT inscricoes/:userId` `{ inscrito: boolean, motivo? }` | `{ userId, inscricao: Inscricao }` (MANUAL) |
| `DELETE inscricoes/:userId` | `{ userId, inscricao: Inscricao \| null, situacao: Situacao }` (desfaz o manual e reconsulta) |
| `GET associados?busca&baseOrigin&inscrito&page&limit` | `{ data: AssociadoAdmin[], meta }` (sem `busca`: quem tem carteira ou inscrição) |
| `GET associados/:userId/extrato?page&limit` | `{ associado: AssociadoAdmin, data: (Lancamento & { baseOrigin, autor })[], meta }` |
| `GET associados/:userId/raspadas?page&limit` | `{ data: RaspadaAdmin[], meta }` |
| `GET associados/:userId/tentativas?page&limit` | `{ data: TentativaAdmin[], meta }` |
| `POST associados/:userId/creditos` `{ valor (≠ 0, com sinal), motivo }` | `{ userId, saldo }` |

```ts
interface Inscricao {
  inscrito: boolean; fonte: 'SGA' | 'MANUAL'; verificadoEm: ISO | null;
  codigoVeiculo: string | null;       // veículo em que o produto foi achado (SGA)
  autor: string | null; motivo: string | null; atualizadoEm: ISO;
}
interface Situacao { inscrito: boolean; motivo: MotivoNaoInscrito | null; fonte: 'SGA' | 'MANUAL' | null; verificadoEm: ISO | null }
interface InscricaoAdmin extends Inscricao {
  associado: { id: number; nome: string; cpfMascarado: string; ativo: boolean };
  baseOrigin: string;
}
interface AssociadoAdmin {
  id: number; nome: string; cpfMascarado: string; baseOrigin: string | null; ativo: boolean;
  saldo: number; totalGanho: number; sequenciaDias: number;
  inscricao: Inscricao | null;        // null: ainda não verificado
}
interface RaspadaAdmin {
  id: number; campanhaId: number; dia: string /* "yyyy-mm-dd" (Brasília) */;
  resultado: 'GANHOU' | 'NAO_GANHOU'; creditos: number; bonus: number; momentoId: number | null; criadoEm: ISO;
}
interface TentativaAdmin {
  id: number; acao: 'RASPAR' | 'COMPRAR' | 'ACESSAR'; codigo: string;
  descricao: string;                  // "Tentou comprar na loja e não conseguiu: produto esgotado"
  contexto: Record<string, string | number | boolean> | null;
  criadoEm: ISO;
}
```

### 6.7 Rodadas do piloto
`GET/POST rodadas`, `GET/PATCH rodadas/:id`, `POST rodadas/:id/publicar|cancelar|duplicar|apurar`,
`GET rodadas/:id/participantes` continuam como no piloto (seção 9). O painel só mostra o menu com
`rodadasHabilitadas = true`.

## 7. Erros

Objeto `{ statusCode, code, message, ...extra }`. 400 de validação de DTO e 404 seguem o padrão do
Nest (`message` em lista/texto, sem `code`).

| Status | `code` | Quando |
|---|---|---|
| 403 | `PROMOCAO_INATIVA` | Base fora de `SORTE_BASES_CONTEMPLADAS` ou promoção desligada |
| 403 | `ASSOCIADO_INATIVO` | `user.isActive = false` |
| 403 | `NAO_INSCRITO` | Sem inscrição (`motivo`: `NAO_INSCRITO` \| `VERIFICACAO_INDISPONIVEL`) |
| 409 | `SEM_CAMPANHA` | Nenhuma campanha publicada na base |
| 409 | `CAMPANHA_FORA_DO_PERIODO` | Antes do início ou depois do fim (`inicio`, `fim`, `serverNow`) |
| 409 | `LIMITE_DIARIO` | Raspadas do dia esgotadas (`proximaRaspadaEm` = próxima 00:00) |
| 409 | `INTERVALO` | Intervalo mínimo não cumprido (`proximaRaspadaEm`) |
| 409 | `ESGOTADO` | Produto (ou rodada) sem estoque |
| 409 | `LIMITE_POR_ASSOCIADO` | Compras do produto atingiram o limite (`limitePorAssociado`) |
| 409 | `CAMPANHA_TRAVADA` | Alterar cronograma/período/base ou excluir campanha publicada/encerrada |
| 409 | `CAMPANHA_JA_PUBLICADA` | Publicar com outra campanha publicada na base |
| 409 | `CAMPANHA_NAO_PUBLICADA` / `CAMPANHA_ENCERRADA` | Encerrar rascunho / já encerrada (ou renomear encerrada) |
| 422 | `CREDITOS_INSUFICIENTES` | Saldo menor que o custo (`saldo`, `necessario`) |
| 422 | `CRONOGRAMA_INVALIDO` | CSV com erro (`erros: { linha, mensagem }[]`) |
| 422 | `CRONOGRAMA_VAZIO` | Publicar sem momentos |
| 422 | `MOMENTOS_FORA_DO_PERIODO` | Momento fora de `[inicio, fim]` (criar/editar/publicar/mudar período) |
| 422 | `CONFIRMACAO_INVALIDA` | `confirmacao` diferente do nome da campanha |
| 422 | `PERIODO_INVALIDO` | `fim <= inicio`, ou publicar com `fim` no passado |
| 422 | `CUSTO_INVALIDO` | Produto na loja com `custoCreditos < 1` |
| 422 | `EMAIL_INVALIDO` / `TELEFONE_INVALIDO` / `FAIXAS_INVALIDAS` | Validações da configuração |
| 422 | `BASE_INVALIDA` | Base fora de `TENANT.baseNames` |
| 429 | `MUITAS_REQUISICOES` | Limite por associado (raspar 10/min, comprar 20/10 s) |
| 503 | `TENTE_NOVAMENTE` | Transação sem vaga no pool |
| — | piloto | `RODADA_NAO_ABERTA`, `RODADA_ENCERRADA`, `JA_PARTICIPANDO`, `JA_GANHOU`, `EM_CARENCIA`, `RODADA_JA_ABERTA`, `EDICAO_BLOQUEADA`, `RODADA_NAO_*`, `PREMIO_EM_USO`, `GANHADOR_CANCELADO`, `ESTOQUE_INSUFICIENTE`, `BILHETES_INVALIDOS` |

## 8. Demonstração e aceite

```bash
npx prisma migrate deploy            # ou migrate dev em banco local
npm run sorte:seed-demo              # dados de demonstração (idempotente; recusa NODE_ENV=production)
npm run start:dev
node --env-file=.env scripts/sorte-aceite.mjs   # roteiro de aceite (62 verificações)
```

O seed (`prisma/seed-associado-sorte-demo.ts`) deixa a MAIS_PRIME pronta para teste rápido:
3 raspadas/dia, intervalo de **1 min**, carência 0, jornada ligada (marcos 3 → 20, 7 → 50),
lembretes 08:00–21:00, convite `5500000000000`, WhatsApp do marketing `5500000000099`, e-mail
`marketing@teste.com.br` (**o e-mail é enviado de verdade pelo Gmail configurado no `.env`**).
"Campanha de demonstração" **publicada** com 3 vouchers já liberados (o primeiro a raspar ganha) e
um a cada 2 min pelas ~3 h seguintes (120/150/200); rodar o seed de novo reaproveita a campanha
enquanto ela tiver momentos para mais de 1 h, senão encerra e publica outra. Loja com 5 produtos
(Furadeira 120, Plano dental 1 mês 89, Reboque 2.000 km 150, Cupom 20% Pagé 60, Garrafa térmica
com estoque 1). Uma segunda campanha em **rascunho** para importar
[`docs/exemplos/cronograma-exemplo.csv`](./exemplos/cronograma-exemplo.csv).
Usuário do painel `marketing.demo@maisprime.local` (MARKETING). Associados: CPF `90000000101`–`103`
**inscritos** (MANUAL, saldo ≥ 300), `104`–`106` **não inscritos** (MANUAL), `90000000201`–`206`
na base RS (promoção inativa). Senha de todos: `Demo@1234`.

O roteiro de aceite encerra a campanha publicada, cria a "Campanha (aceite)", usuários
`Aceite NN` (CPF `900000009NN`) e produtos "(aceite)", ajusta datas de raspadas desses usuários no
banco local para simular 60 min, a virada do dia e 3 dias de jornada, e no fim restaura a
configuração e roda o seed de novo.

**App com os associados de demonstração**: suba `node scripts/sorte-proxy-demo.mjs` (porta 3999) e
aponte o app com `EXPO_PUBLIC_API_BASE_URL=http://<ip>:3999/api`. O proxy responde só para os CPFs
de demonstração `verificar-situacao`, `sga/veiculos`, `sga/associado` e
`sga/beneficios-veiculo/999001` (com o produto 3677 ATIVO); a inscrição no backend vem da marcação
MANUAL do seed.

## 9. Contrato do piloto que continua valendo (rodadas)

Com `rodadasHabilitadas = true`:
`GET rodadas/:id` → `{ serverNow, saldo, emCarenciaAte, rodada: Rodada, ganhadores: { nome, premio, imagemUrl, ganhouEm }[] }`;
`POST rodadas/:id/participar { bilhetes? }` → `{ serverNow, participacao: { rodadaId, bilhetes, creditosGastos }, saldo }`;
`POST rodadas/:id/resgatar` → `{ serverNow, ganhador: MeuPremio, saldo }`;
`POST`/`DELETE rodadas/:id/lembrete` → `{ rodadaId, lembrete }`.

```ts
interface Rodada {
  id: number; titulo: string; mecanica: 'SORTEIO' | 'CORRIDA' | 'RESGATE';
  fase: 'EM_BREVE' | 'ABERTA' | 'ESGOTADA' | 'APURANDO' | 'ENCERRADA';
  abertura: ISO; encerramento: ISO; custoCreditos: number; modoCredito: 'CONSOME' | 'SALDO_MINIMO';
  bilhetesMaximos: number; quantidade: number; unidadesRestantes: number; totalParticipantes: number;
  premio: { id: number; nome: string; descricao: string | null; imagemUrl: string | null; valorEstimado: number | null };
  minha: { participando: boolean; bilhetes: number; ganhou: boolean; ganhadorId: number | null; lembrete: boolean };
}
```
`RodadaAdmin`, `ResumoApuracao` e as regras de rodada (estados, fase, estoque reservado, apuração,
carência de SORTEIO/CORRIDA) não mudaram em relação ao piloto (ver histórico do Git deste arquivo).

## 10. Decisões (onde a especificação deixou margem)

- **Ordem de trava da raspada: carteira → momento**, com o momento em `SKIP LOCKED`. A seção 2.2
  da especificação cita "momento e depois a carteira", mas os passos numerados checam limite e
  intervalo (carteira) antes de buscar o momento. Travar o momento primeiro prenderia o voucher
  enquanto a raspada espera a carteira do mesmo associado, e quem raspasse nesse instante o
  pularia (SKIP LOCKED). Como o momento nunca espera trava, não há ciclo de deadlock.
- **Intervalo só dentro do dia**: a 1ª raspada do dia libera às 00:00 (critério "à 00:00 o contador
  volta" e "o primeiro aviso do dia é a liberação da 00:00").
- **Linha duplicada** = mesmo horário, créditos e descrição. Dois vouchers diferentes no mesmo
  minuto são permitidos.
- **Publicação**: exige a confirmação com o nome no servidor; só uma publicada por base
  (409 `CAMPANHA_JA_PUBLICADA`); o nome continua editável (não entra no hash). O job encerra a
  campanha publicada cujo `fim` passou, para liberar a publicação da próxima.
- **Hash** inclui id, base, início, fim e os momentos (`liberaEm;creditos;descricao`) — formato na 2.4.
- **Inscrição**: HTTP 404/406 do SGA = não inscrito; falha nos produtos de um veículo sem nenhum
  outro inscrito = indisponível (usa o cache); espera de 60 s após falha; marcação manual pode ser
  `true` ou `false`; `reverificar` com marcação manual devolve o resultado do SGA em `sga` sem gravar.
- **Carência v2** conta os vouchers da raspadinha (raspadas `GANHOU`); a carência das rodadas do
  piloto continua contando SORTEIO/CORRIDA.
- **`SorteGanhadorOrigem`** é um enum novo (`SORTEIO|CORRIDA|RESGATE|LOJA`) em vez de pôr `LOJA` em
  `SorteMecanica` (a rodada não pode ter mecânica LOJA). A unicidade da corrida/vitrine (uma unidade
  por associado por rodada, contando cancelados como antes) passou para a transação.
- **`SorteRaspada.createdAt`** (a especificação chama de `criadoEm`): mesmo padrão dos outros
  modelos do módulo; a API expõe `criadoEm`.
- **E-mail**: `MailService` não está na lista de god services de `docs/ARQUITETURA_ALVO_2026-09.md`
  (380 linhas, sem a marcação) → ganhou o método `sendSorteNovaRetiradaEmail`, no padrão dos
  demais (Gmail). O usuário não tem telefone no cadastro: o e-mail usa o telefone confirmado no
  pedido (normalmente "não informado" na hora da compra).
- **Notificações do painel na transação da compra** (atômicas com o pedido); só o e-mail e o push
  saem depois do commit.
- **`SorteColetaDiariaService` e `POST credito-diario/coletar` removidos** (substituídos pela
  raspadinha); a tabela fica.
- **Rotas de rodada do painel continuam ativas** com a flag desligada (o painel esconde o menu;
  dados e apuração seguem acessíveis).
- **Tentativas**: `NAO_INSCRITO` em raspar/comprar é gravado com a ação `RASPAR`/`COMPRAR`; nas
  outras rotas, `ACESSAR`. `MUITAS_REQUISICOES` não é gravada (evita inundar a tabela).
- **Lembretes** só para quem tem `SorteInscricao` com `inscrito = true` (verificado ao abrir o app
  ou marcado no painel) e só com campanha no período.
- **Limite de requisições falha aberto** se o Redis cair (as travas garantem a regra).

## 11. Fora do escopo / pendências

Fora: sorteio do carro e das motos, base MAIS_PRIME_RS, expiração de créditos, integração com o app
de estoque do marketing, envio automático de WhatsApp (só links wa.me), ativação automática de
serviços no SGA, build nativo/OTA/deploy.

Pendências com o marketing: e-mail real de `emailNotificacoes`, número do `whatsappMarketing` (e do
convite), formato final da planilha do cronograma, texto do regulamento.
