# Revistoria — regras por empresa (base)

O mesmo backend roda em duas VPS:

| VPS | `TENANT_BASES` | Perfil de regra |
|---|---|---|
| Mais Prime | `MAIS_PRIME:,MAIS_PRIME_RS:_RS` | `PADRAO` (as duas bases juntas, regra vigente) |
| Hertz | `HERTZ` | `HERTZ` |

Tudo que muda entre empresas no fluxo de revistoria + boleto de reativação fica em **um arquivo**: `src/config/revistoria-regra.config.ts`. O resto do fluxo é compartilhado.

## O que cada perfil define

| Regra | `PADRAO` (Mais Prime / RS) | `HERTZ` |
|---|---|---|
| Situação do veículo que exige revistoria | `INADIMPLENTE 20 DIAS` | `INADIMPLENTE` (código 4) |
| Tipo do SGA → template de fotos | por "contém" (idêntico ao `mapTipoToVehicleType` do app) | tabela exata: `AUTOMOVEL LEVE(S)` e `CAMIONETAS, UTILITARIOS, HIBRIDOS E TROLLER` → `VEICULOS_LEVES`; `MICRO-ONIBUS, MINIBUS E CAMINHOES` → `CAMINHOES`; `MOTOCICLETA` → `MOTOS` |
| `codigo_conta` do `boleto/cadastrar` | 27 | 2 |
| `codigo_tipo_boleto` (cadastro e adoção) | 2 | 2 (REVISTORIA) |
| Situação do veículo após cadastrar o boleto | 20 (aguardando reativação) | não altera — segue INADIMPLENTE até o pagamento |
| Situação do veículo / associado após o pagamento | 1 / 1 | 1 / 1 (ATIVO) |
| Valor do boleto de reativação | valor base (produtos ativos + taxa administrativa) | valor base + multa de 2% (uma vez) + mora de 0,5% ao dia, contados do vencimento do último boleto em aberto — seção "Encargos por atraso" |
| Boleto em aberto anterior | não é tocado | deve ser cancelado (pendente de rota da Hinova; hoje fica como ação manual) |

Iguais em todo SGA da Hinova e por isso **fora** do perfil: situações de boleto (1 e 4 pago, 2 aberto, 3 e 999 encerrado), janela de vencimento, retry, Suri e e-mails (estes por `.env` de cada VPS).

No boot, cada base loga o perfil aplicado (`RevistoriaRegraService`):
```
[HERTZ] regra de revistoria: perfil=HERTZ | situações=INADIMPLENTE | conta boleto=2 | situação após boleto=não altera
```
Se uma base aparecer com `perfil=PADRAO` sem querer, o nome em `TENANT_BASES` não bate com a chave em `REGRAS_POR_BASE`.

## Onde a regra é usada

- `GET /api/reinspection/regra` (app) e `GET /api/reinspection/regras` (painel — tela Templates de Fotos).
- `GET /api/sga/veiculos` → campo aditivo `revistoria_obrigatoria`; `GET /api/sga/veiculos-info/:chassi` → campo aditivo `template_revistoria`.
- `SgaService.criarBoletoReativacao` (conta, tipo, situação após o boleto), `BoletoReativacaoService` (tipo na adoção) e `BoletoVerificacaoProcessor` (situações após o pagamento).

## App da Hertz

Repositório próprio (`AppAssociadoHertz`). A regra vive em `lib/revistoria-regra.ts`: `exigeRevistoria` (situação `INADIMPLENTE`), `templateHertzPorTipo` e `revistoriaAguardandoConclusao` — como o veículo da Hertz segue INADIMPLENTE após a aprovação, revistoria `APROVADA` conta como "aguardando pagamento" (sem aviso, sem refazer; tela de status mostra "Aprovada — aguardando pagamento").

## Nova empresa

1. Criar `REGRA_<EMPRESA>` em `src/config/revistoria-regra.config.ts` (partir de `REGRA_PADRAO` com spread e sobrescrever só o que difere).
2. Adicionar a entrada em `REGRAS_POR_BASE` com o nome usado em `TENANT_BASES`.
3. Cobrir no `revistoria-regra.config.spec.ts`. **Nunca** alterar `REGRA_PADRAO`.
4. Validar na Hinova da empresa: contas bancárias, tipos de boleto, situações de boleto/veículo/associado.

## Base ausente (novembro de 2026)

A regra é resolvida pela base do dono do veículo (ou do token, em `GET /reinspection/regra`). Sem base
conhecida a operação responde 422 `BASE_NAO_RESOLVIDA`: não existe mais "cair na regra da base
padrão". Base configurada em `TENANT_BASES` sem entrada em `REGRAS_POR_BASE` continua usando a
`REGRA_PADRAO`.

## Encargos por atraso no boleto de reativação — só Hertz (novembro de 2026)

Na Hertz o boleto de reativação não sai mais pelo valor base puro. A regra fica em
`REGRA_HERTZ.boleto.encargosPorAtraso` (`src/config/revistoria-regra.config.ts`); na `REGRA_PADRAO`
(Mais Prime e Mais Prime RS) o campo é `null` e nada muda: nenhuma consulta a mais ao SGA, mesmo valor.

**Cálculo** (`src/sga/domain/boleto-encargos.ts`, função pura):

```
total = base + multa + mora
base  = produtos ativos + taxa administrativa   (o valor de sempre do boleto de reativação)
multa = 2% da base, UMA vez, só se houver atraso (nunca por dia)
mora  = 0,5% da base por dia de atraso
```

Exemplo: base R$ 129,90 e 16 dias de atraso → multa R$ 2,60 + mora R$ 10,39 → boleto de R$ 142,89.
As contas são feitas em centavos; multa e mora são arredondadas ao centavo, cada uma.

**De onde vem o atraso.** Antes de cadastrar o boleto, a API busca no SGA o **último boleto em aberto**
do veículo: situação ABERTO (2), vencimento até hoje, o de vencimento mais recente
(`POST /listar/boleto-associado-veiculo` com `codigo_situacao_boleto` e `data_vencimento_inicial/final`,
em janelas de 90 dias, até 360 dias para trás). Os dias contam do vencimento desse boleto até o dia em
que o boleto novo é gerado.

- Boleto que ainda vai vencer não entra: não há atraso nele e ele não é cancelado.
- Sem nenhum boleto em aberto vencido, o boleto sai pelo valor base.
- Se o boleto em aberto já é um boleto de reativação gerado por esta API com encargos, o atraso conta
  da data de referência gravada com ele — não recomeça do zero quando um boleto de reativação vence
  sem pagamento.
- Falha ao consultar o SGA **impede** a geração (entra no retry de sempre): boleto sem os encargos
  devidos seria cobrança errada.

**Memória de cálculo.** Fica gravada em `ReinspectionPayment.encargos` (JSON): valor base, multa, mora,
total, dias, data de referência, o boleto em aberto que serviu de base e a situação do cancelamento
dele. O mesmo resumo vai para o log.

**Cancelamento do boleto em aberto — PENDENTE DE INFORMAÇÃO DA HINOVA.** A regra pede que o boleto em
aberto seja cancelado depois de gerar o novo. A documentação pública da API do SGA (v2, consultada em
26/11/2026) **não tem rota para cancelar, excluir ou mudar a situação de um boleto**: as de escrita são
só `boleto/cadastrar` e `alterar/vencimento-boleto`. Por isso `SgaBoletoClient.cancelarBoleto` ainda
não chama o SGA. Enquanto isso:

- o boleto antigo fica registrado como `PENDENTE_MANUAL` em `encargos.cancelamento`;
- o e-mail de "revistoria aprovada" enviado à cobrança traz o bloco "Ação necessária", com o número e o
  vencimento do boleto a cancelar à mão e a composição do valor do boleto novo.

Quando a Hinova informar a rota (método, caminho, corpo e resposta), o único ponto a implementar é
`SgaBoletoClient.cancelarBoleto`; o resto do fluxo já trata sucesso e falha.

Para listar o que ainda precisa ser cancelado à mão:

```sql
SELECT nossoNumero AS boleto_novo,
       JSON_VALUE(encargos, '$.boletoAnterior.nossoNumero') AS boleto_a_cancelar,
       JSON_VALUE(encargos, '$.boletoAnterior.vencimento')  AS vencimento,
       JSON_VALUE(encargos, '$.valorTotal')                 AS valor_novo,
       boletoCriadoEm
  FROM ReinspectionPayment
 WHERE JSON_VALUE(encargos, '$.cancelamento.situacao') = 'PENDENTE_MANUAL'
 ORDER BY boletoCriadoEm DESC;
```

**O que a regra não cobre.** Boleto adotado (criado à mão no SGA por uma operadora, antes da aprovação)
vale como está: a API não recalcula o valor dele nem cancela outro boleto.

