import type { BaseOrigin } from 'src/config/tenant.config';
import { formatDateBR } from 'src/shared/date.util';
import { referenciaDaRevistoria } from 'src/sga/domain/boleto-adocao';
import {
  DadosAssociadoBoleto,
  ProdutosDoVeiculo,
} from 'src/sga/domain/boleto-sga.parser';
import type { RegistroDeEncargos } from 'src/sga/domain/boleto-encargos';

/** Códigos do `boleto/cadastrar` que variam por empresa (regra da base). */
export interface CodigosDoBoleto {
  codigoConta: number;
  codigoTipoBoleto: number;
}

/** Texto do item do boleto; a referência da revistoria vai no fim. */
const DESCRICAO_DO_BOLETO = 'Boleto reativação app';

/**
 * Descrição enviada em `referencia[].descricao`. Com a revistoria conhecida
 * leva `REV-<id>`: é a marca que permite reconhecer, numa listagem do SGA, o
 * boleto que a própria API cadastrou (ver `boleto-adocao.ts`).
 */
export function descricaoDoBoleto(reinspectionId?: number): string {
  return reinspectionId
    ? `${DESCRICAO_DO_BOLETO} ${referenciaDaRevistoria(reinspectionId)}`
    : DESCRICAO_DO_BOLETO;
}

/**
 * Valor base do boleto de reativação, em reais: produtos ativos + taxa
 * administrativa (que pode ser negativa).
 */
export function valorBaseDoBoleto(produtos: ProdutosDoVeiculo): number {
  return (
    parseFloat(produtos.taxaAdministrativa) + produtos.valorTotalProdutosAtivo
  );
}

/**
 * Corpo de `POST /boleto/cadastrar` do boleto de reativação: valor base
 * (ver `valorBaseDoBoleto`), parcela única com vencimento no dia seguinte e
 * mês de referência corrente.
 *
 * `valorTotalCentavos` substitui o valor base quando a regra da empresa
 * cobra encargos por atraso (ver `boleto-encargos.ts`).
 */
export function montarCadastroDoBoleto(params: {
  associado: DadosAssociadoBoleto;
  produtos: ProdutosDoVeiculo;
  codigos: CodigosDoBoleto;
  agora: Date;
  reinspectionId?: number;
  valorTotalCentavos?: number;
}) {
  const { associado, produtos, codigos, agora } = params;

  const total =
    params.valorTotalCentavos != null
      ? params.valorTotalCentavos / 100
      : valorBaseDoBoleto(produtos);
  const valor = total.toFixed(2).replace('.', ',');

  const mesReferente = `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;
  const amanha = new Date(agora);
  amanha.setDate(amanha.getDate() + 1);

  return {
    codigo_associado: associado.codigoAssociado,
    codigo_regional: associado.codigoRegional,
    codigo_situacao: '2',
    codigo_conta: codigos.codigoConta,
    mes_referente: mesReferente,
    link_boleto: true,
    codigo_tipo_boleto: codigos.codigoTipoBoleto,
    array_parcela: [{ valor, vencimento: formatDateBR(amanha) }],
    referencia: [
      {
        modulo: 'veiculo',
        codigo_modulo: produtos.codigoVeiculo,
        descricao: descricaoDoBoleto(params.reinspectionId),
        valor,
      },
    ],
  };
}

/** O que o cadastro do boleto devolve a quem orquestra a tentativa. */
export interface BoletoReativacaoCriado {
  nossoNumero: string | null;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
  codigoVeiculo: string | null;
  codigoAssociado: number;
  /** A verificação de pagamento ficou agendada (linha na varredura). */
  pollerAgendado: boolean;
  suriEnviada: boolean;
  /**
   * Situação do veículo após o boleto: `true` alterada, `false` o SGA
   * recusou ou a chamada falhou, `null` a regra da base não altera.
   */
  situacaoVeiculoAlterada: boolean | null;
  /** Memória de cálculo dos encargos; `null` quando a regra não os cobra. */
  encargos: RegistroDeEncargos | null;
  /**
   * Algo que ficou para a equipe fazer à mão (ex.: cancelar no SGA o boleto
   * que este substituiu). `null` = nada pendente.
   */
  pendencia: string | null;
}

export interface RegistroDoBoleto {
  userVehicleId: number;
  reinspectionId?: number;
  nossoNumero: string | null;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
  debugId?: string;
  /** Dados da verificação de pagamento (o que o job repetível carregava). */
  baseOrigin?: BaseOrigin;
  codigoVeiculo?: string | null;
  associado?: DadosAssociadoBoleto;
  /** Memória de cálculo dos encargos por atraso, quando houver. */
  encargos?: RegistroDeEncargos;
}

export interface ConclusaoDoBoleto {
  userVehicleId: number;
  baseOrigin: BaseOrigin;
  nossoNumero: string | null;
  linkBoleto: string | null;
  codigoVeiculo?: string | null;
  associado: DadosAssociadoBoleto;
  debugId?: string;
}
