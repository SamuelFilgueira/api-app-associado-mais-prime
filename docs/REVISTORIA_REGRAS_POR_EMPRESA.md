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
