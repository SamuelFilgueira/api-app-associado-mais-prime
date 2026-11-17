# Associado da Sorte — o que o marketing pediu (reunião de 13/11/2026)

Fonte: áudio da reunião com o gestor de marketing (`/home/samuel/Músicas/reuniao.mp4`, ~11 min),
transcrito com Whisper large-v3 em `/home/samuel/Músicas/reuniao-transcricao.txt`. Os tempos entre
colchetes apontam para a transcrição. Onde o áudio é ambíguo, está marcado como **[a confirmar]**.

## 1. A ideia em uma frase

O associado inscrito no produto "Associado da Sorte" do SGA **raspa uma raspadinha no app para
descobrir se ganhou um voucher em créditos**; os créditos (1 crédito = R$ 1) ficam numa carteira e
são gastos na **Loja da Sorte**, um catálogo de produtos cadastrados pelo marketing. Cada compra
desconta do estoque e avisa a equipe, que chama o associado no WhatsApp para combinar a retirada.
Os prêmios que "saem" na raspadinha seguem um **cronograma fixado antes da campanha**, auditado
pelo Ministério da Fazenda e que não pode ser alterado depois do início.

## 2. Quem participa

- **Só quem está inscrito participa.** A inscrição é um **produto ativado no SGA** ("A gente ativa
  o produto no SGA") [01:47–01:53]. Dá para descobrir os inscritos pelo relatório do SGA [09:12–09:18].
- **Inscrito** vê o painel completo da promoção (saldo, raspadinha, Loja da Sorte) [01:55].
- **Não inscrito** vê só um **convite para participar** ao abrir a área [01:36–02:05].
- Quem ainda não está inscrito pode ser adicionado ao produto pela equipe e passa a estar apto [09:04–09:21].

**Como:** a elegibilidade deixa de ser "promoção ativa na base" e passa a ser "associado com o
produto Associado da Sorte ativo no SGA". O backend já consulta
`produto-vinculado-veiculo/listar/<veículo>` (`BeneficiosVeiculoService`), que devolve os produtos
do veículo com `codigo_produto` e `situacao`; basta configurar o código do produto por base.

## 3. Raspadinha: "raspa para ver se ganhou"

- O associado **raspa para descobrir se ganhou** [02:19–02:25]. Ganhou → **soma créditos** na
  carteira [02:25–02:31]. Crédito é uma moeda inventada para não lidar com dinheiro: **100 reais =
  100 créditos** [02:28–02:31].
- **O prêmio da raspadinha é sempre um voucher** [10:01–10:07]:
  - voucher padrão de **120 créditos** (a campanha foi divulgada como "prêmios a partir de R$ 120") [09:30–09:43];
  - ocasionalmente um voucher de **200 créditos**, com o critério de **um a cada 17 dias** [09:44–09:56];
  - um valor intermediário de **150** está em avaliação [10:11–10:14]. Os valores vêm da planilha, então devem ser livres.
- **Quantas vezes raspar:** "ele pode raspar quantas vezes quiser" [03:05–03:13]. No começo da
  conversa isso aparece como algo "a definir" ("quantas raspadas cada CPF tem por dia") [00:33–00:48]. **[a confirmar]**
- **Registrar tudo:** quem raspou, quando raspou e, principalmente, quem ganhou [03:15–03:37].
- **Notificações** para lembrar o associado de raspar [03:41–03:57].

### A regra do horário (o ponto central da reunião)

- O Ministério da Fazenda exige a **campanha inteira pronta antes de começar**: prêmios (inclusive
  **um carro e motos sorteados**), datas e valores, com **nota fiscal de tudo**, "como se a gente
  tivesse comprado antes de começar" [07:50–08:04].
- O **sistema também não pode ser alterado depois do início** da campanha [08:06–08:12]. É
  permitido **adicionar e tirar produtos** da loja, "mas a base é a mesma" [08:14–08:18].
- Cada prêmio tem um **horário de saída pré-configurado**. Se está programado para as 15h, **ninguém
  pode ganhá-lo antes das 15h**. Depois das 15h pode sair a qualquer momento: se o primeiro a
  acessar raspou às 15h30, ele ganha ("posso alegar que ninguém acessou antes") [08:20–08:42].
- "O que eu configurar hoje que vai ser a premiação, vai ser" [08:44–08:47]. Haverá **auditoria**
  sobre isso [08:58–09:00].
- O marketing está montando uma **planilha com datas, prêmios e valores** para espaçar e
  configurar o ano inteiro [08:49–08:58]. Ideia anterior (de outra pessoa da equipe): **um sorteio
  por dia**, com agenda do ano todo [07:32–07:41].

**Como:** isso é o modelo de "momentos premiados" (instant win com horário). O cronograma vira uma
lista de momentos `{ data/hora de liberação, valor do voucher }`. Ao raspar, o servidor procura o
momento **mais antigo já liberado e ainda não ganho**; se achar, o associado ganha aquele voucher;
se não, "não foi dessa vez". Um momento nunca sai antes da hora e, se ninguém raspar, fica
disponível até alguém raspar. O cronograma é importado da planilha, conferido e **travado na
publicação**, com exportação para a auditoria.

## 4. Loja da Sorte

- Nome dado pelo gestor: **Loja da Sorte** [02:05–02:17].
- O marketing **cadastra os produtos e o valor em créditos** de cada um [02:34–02:44].
- **Comprar desconta da carteira de pontos** e **gera um aviso para a equipe** de que alguém fez a
  retirada [02:44–02:53]. A equipe **entra em contato para combinar a entrega** [02:51–02:58], pelo
  WhatsApp com uma mensagem padrão (como no esboço apresentado) [07:04–07:11].
- O saldo que sobra pode ser usado em outro item: ex. voucher de 120, furadeira a 120 ou 89,90, e
  o resto para um plano dental [10:17–10:31].
- **Estoque:** cadastrar com quantidade e **descontar automaticamente** a cada retirada [05:46–06:09].
  O gestor tem um app próprio de estoque e vai **cruzar** os números com os do sistema [05:58–06:08].
- **Tipos de produto** que podem entrar [03:58–05:28]:
  - **produtos físicos** da campanha (ex.: furadeira);
  - **serviços da Mais Prime**: ampliar reboque para 2.000 km por um mês, plano dental,
    telemedicina, auxílio pet, reserva. Nesse caso **alguém ativa o produto no SGA à mão**;
  - **cupons de parceiros**: ex. 20% na Pagé Amortecedores. A equipe orienta o associado a ir ao
    parceiro com o cupom ou a imagem.
- No primeiro momento, o cadastro é **manual, só pela equipe**, com os produtos que já existem [05:39–05:44].
- Objetivo de negócio: manter o associado voltando ao app; a cada visita ele **vê o boleto para
  pagar** [05:13–05:25].

## 5. Painel (o que o gestor viu e validou no esboço)

Mostrado na reunião e sem objeção [06:13–07:41]:

- configuração da raspadinha com probabilidade e créditos (**substituída** pela regra de vouchers
  com horário da seção 3);
- crédito por check-in e marcos de sequência (3 dias seguidos = +2, 7 dias = +10). **Não foi
  comentado** se continua; **[a confirmar]**;
- **Ganhadores** com o WhatsApp do associado e mensagem padrão;
- **Associados** com o extrato completo: o que fez, quais créditos pegou, o que tentou e **não
  conseguiu, e por quê**;
- agenda / cronograma.

## 6. Prazo e contexto

- Os associados **já estão com adesivo no carro e cobrando o sorteio**; o gestor está preocupado
  com o atraso [10:47–10:57].
- Compromisso dado na reunião: **MVP até o meio da semana que vem** (por volta de 18/11/2026) [11:03–11:06].
- O gestor vai mandar a **planilha** (datas, prêmios e valores) para deixar tudo pré-programado [11:10–11:17].

## 7. Perguntas em aberto para o marketing

1. **Limite de raspadas:** ilimitado, uma por dia ou N por dia por CPF? Com raspadas ilimitadas,
   quem raspa sem parar logo depois do horário leva quase todos os vouchers.
2. **Um associado pode ganhar mais de um voucher?** Se sim, existe intervalo mínimo (carência)?
3. **Momento não ganho:** fica disponível até alguém raspar (inclusive em outro dia) ou expira no
   fim do dia?
4. **Cronograma por base:** Mais Prime e Mais Prime RS têm cronogramas e lojas separados ou compartilhados?
5. **Inscrição no SGA:** qual o código do produto "Associado da Sorte" em cada base? O produto fica
   no veículo; quem tem dois veículos inscritos conta como um participante ou dois?
6. **Carro e motos:** são sorteados dentro do app ou fora (ex.: Loteria Federal)? Em que data?
7. **Créditos expiram?** O que acontece com o saldo no fim da campanha?
8. **Serviços Mais Prime e cupons:** limite por associado? Qual a duração (ex.: reboque por 1 mês)?
   O cupom é um código único por compra ou uma imagem igual para todos?
9. **Convite para não inscritos:** o botão leva para onde (WhatsApp do consultor, telefone, link)?
10. **Formato da planilha:** quais colunas? Sugestão: `data`, `hora`, `créditos`, `descrição`, `base`.
11. **Aviso de retirada para a equipe:** basta o painel ou precisa e-mail / WhatsApp?
12. **Check-in e marcos de sequência:** mantém, como fonte extra de créditos, ou sai?
13. Lembrete para raspar: **horário** e **frequência** (diário?) e se vai para todos os inscritos.

## 8. Respostas do gestor (16/11/2026) — regra definitiva

1. **O sorteado é sempre o voucher**, nunca o produto. A planilha diz "dia 14/12, 09:40:31, Voucher R$120".
2. O voucher vira créditos que valem para **qualquer produto da Loja da Sorte**, inclusive os que entrarem depois.
3. **Ganhador:** o associado apto que raspar no horário estipulado ou **o primeiro depois dele**
   (voucher das 15:00, raspou às 15:00:01 → ganha). Isso é exatamente o modelo de momentos premiados
   já implementado; nada muda na lógica do sorteio.

Planilha oficial recebida: `Associado-da-Sorte_Cronograma-vale-brinde.xlsx` — aba **Cronograma**
(`Dia | Horário | Prêmio`, 14/12/2026 a 13/12/2027, um voucher por dia, horário aleatório entre
08:00:00 e 19:59:59 com segundos) e aba **Resumo** (344 × R$ 120 + 21 × R$ 200 = 365 prêmios,
R$ 45.480). O painel importa o .xlsx direto e confere o Resumo contra o cronograma.
