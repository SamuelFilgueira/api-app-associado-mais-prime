# Sincronização do cadastro do associado com o SGA

**Desde:** 2026-09-24

## Problema

O cadastro local (`user.name`, `user.email`, `user.cep`, `user.address`) é
criado uma única vez no primeiro acesso, a partir do SGA. Quando o associado
atualiza e-mail ou endereço no SGA, o app continua mostrando o valor antigo
(`GET /auth/me` lê do banco) e o suporte precisa corrigir manualmente.

## Solução

Quando o app faz `GET /api/sga/associado` **ou** `GET /api/sga/veiculos`
(consultas iniciais após o login; as duas batem em
`GET /associado/buscar/{cpf}` do SGA), o corpo que o SGA já devolveu é
reaproveitado para alinhar o cadastro local.

| Item | Como |
|---|---|
| Requisições extras à Hinova | **Zero.** Usa o corpo de `GET /associado/buscar/{cpf}` que a rota já buscava. |
| Leituras extras no banco | **Zero.** O `user` já era lido para resolver o CPF; a mesma leitura passou a trazer `name/email/cep/address/baseOrigin`. A `baseOrigin` do usuário agora é passada direto ao SGA, o que também elimina o `findFirst` por CPF que existia no fallback. |
| Escritas no banco | **Só quando algo mudou.** Comparação em memória; se igual, nenhum `UPDATE`. |
| Latência para o app | **Nenhuma.** A gravação roda em segundo plano (`sincronizarEmSegundoPlano`); a resposta ao app é a mesma de antes. |
| Falhas | Só logadas (`warn`). Nunca alteram a resposta da rota. |

## Onde está

- `src/sga/helpers/associado-sga.helper.ts` — funções puras: extrai os campos
  do corpo do SGA (objeto ou array), monta o endereço **no mesmo formato do
  `primeiroAcesso`** (`logradouro numero bairro cidade`) e calcula o diff.
- `src/sga/services/associado-sincronizacao.service.ts` — compara e grava.
- `src/sga/services/sga.service.ts` (`consultarAssociado` e
  `consultarVeiculosAssociado`) — pontos de disparo, após a resposta 2xx do
  SGA. Se o app chamar as duas rotas na abertura e algo tiver mudado, pode
  haver dois `UPDATE` idênticos naquela única vez; em regime, zero escritas.

## Regras

- **O SGA é a fonte de verdade.** Valor diferente no SGA sobrescreve o local,
  inclusive edições feitas pelo app (`PATCH /associado/:id`) ou pelo suporte.
- **Campo vazio no SGA nunca apaga o valor local.** E-mail sem `@` é ignorado.
- **Trava de CPF.** Se o corpo do SGA trouxer um CPF diferente do usuário,
  nada é gravado.
- Respostas 406/4xx/5xx e corpos de erro em 2xx (`{ mensagem, error }`) não
  disparam sincronização.
- Logs registram apenas os **nomes** dos campos alterados, nunca os valores.

## Fora do escopo

- Placa, foto de perfil, telefone e demais campos não são sincronizados.
- `GET /auth/me` continua lendo só do banco. Se o app chamar `/auth/me` antes
  das rotas do SGA, o valor novo aparece na próxima leitura do perfil.
