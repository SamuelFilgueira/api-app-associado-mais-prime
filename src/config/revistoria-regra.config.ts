import { BaseOrigin } from 'src/config/tenant.config';
import { exigirBase } from 'src/shared/tenant/tenant-context';

/**
 * Regra de revistoria por base (tenant) — ponto único do que muda entre
 * empresas no fluxo de revistoria + boleto de reativação.
 *
 * Define, para cada base:
 *  - quais situações do veículo no SGA obrigam a revistoria;
 *  - qual template de fotos (`ReinspectionVehicleType`) cada tipo de veículo
 *    do SGA (`tipo` de `/veiculo/buscar`) usa;
 *  - os códigos do SGA usados no boleto de reativação (conta, tipo de boleto)
 *    e as situações aplicadas ao veículo/associado depois do boleto e do
 *    pagamento.
 *
 * `REGRA_PADRAO` reproduz exatamente a regra vigente de MAIS_PRIME e
 * MAIS_PRIME_RS (mesma VPS, mesma empresa). Ela NÃO deve ser alterada para
 * atender outra empresa: cada empresa nova ganha a própria constante e uma
 * entrada em `REGRAS_POR_BASE`. Bases sem entrada usam `REGRA_PADRAO`.
 *
 * O que é igual em todo SGA da Hinova (ex.: códigos de situação do boleto —
 * 1/4 pago, 2 aberto, 3/999 encerrado) fica fora daqui, nos próprios fluxos.
 */

/** Template de fotos da revistoria. Espelha o enum `ReinspectionVehicleType`. */
export type TemplateRevistoria = 'VEICULOS_LEVES' | 'MOTOS' | 'CAMINHOES';

/**
 * Como o `tipo` do SGA é comparado com os termos:
 *  - `contem`: o tipo (em maiúsculas) contém o termo — regra legada da
 *    Mais Prime, idêntica ao app;
 *  - `exato`: o tipo é igual ao termo, ignorando caixa, acentos e espaços
 *    repetidos (ex.: `MICRO-ÔNIBUS` casa com `MICRO-ONIBUS`).
 */
export type ModoComparacaoTipo = 'contem' | 'exato';

export interface MapeamentoTipoTemplate {
  template: TemplateRevistoria;
  termos: string[];
}

/**
 * Encargos por atraso somados ao valor do boleto de reativação. O atraso é
 * contado a partir do vencimento do último boleto em aberto do veículo
 * (ver `src/sga/domain/boleto-encargos.ts`).
 */
export interface RegraEncargosPorAtraso {
  /**
   * Multa em % do valor base, cobrada UMA vez quando há atraso. Nunca é
   * multiplicada pelos dias.
   */
  multaPercentual: number;
  /** Mora em % do valor base POR DIA de atraso. */
  moraDiariaPercentual: number;
  /**
   * Depois de gerar o boleto novo, cancelar no SGA o boleto em aberto que
   * serviu de base (ele foi substituído).
   */
  cancelarBoletoEmAberto: boolean;
}

/** Códigos do SGA usados no boleto de reativação após a revistoria aprovada. */
export interface RegraBoletoReativacao {
  /** `codigo_conta` do `boleto/cadastrar` (conta bancária da empresa no SGA). */
  codigoConta: number;
  /** `codigo_tipo_boleto` do cadastro e da adoção de boleto criado à mão. */
  codigoTipoBoleto: number;
  /**
   * Situação aplicada ao veículo logo após cadastrar o boleto
   * (`veiculo/alterar-situacao-para`). `null` = não altera: o veículo segue
   * na situação atual até o pagamento.
   */
  situacaoVeiculoAposBoleto: number | null;
  /** Situação aplicada ao veículo quando o boleto é pago. */
  situacaoVeiculoAposPagamento: number;
  /** Situação aplicada ao associado quando o boleto é pago. */
  situacaoAssociadoAposPagamento: number;
  /**
   * Multa e mora por atraso no valor do boleto. `null` = o boleto sai pelo
   * valor base (produtos ativos + taxa administrativa), sem encargos.
   */
  encargosPorAtraso: RegraEncargosPorAtraso | null;
}

export interface RegraRevistoria {
  /** Nome do perfil de regra, usado em logs. Ex.: `PADRAO`, `HERTZ`. */
  perfil: string;
  /** Situações do veículo no SGA que obrigam a revistoria. */
  situacoes: string[];
  modoComparacaoTipo: ModoComparacaoTipo;
  /** Avaliado em ordem: o primeiro mapeamento que casar define o template. */
  mapeamentos: MapeamentoTipoTemplate[];
  /** Template usado quando o tipo do SGA não casa com nenhum mapeamento. */
  templatePadrao: TemplateRevistoria;
  boleto: RegraBoletoReativacao;
}

/** Regra vigente da Mais Prime / Mais Prime RS — não alterar. */
export const REGRA_PADRAO: RegraRevistoria = {
  perfil: 'PADRAO',
  situacoes: ['INADIMPLENTE 20 DIAS'],
  modoComparacaoTipo: 'contem',
  mapeamentos: [
    {
      template: 'VEICULOS_LEVES',
      termos: [
        'VEICULOS - LEVES',
        'VEICULOS LEVES',
        'GRUPO 1',
        'GRUPO 2',
        'VEICULOS CAMIONETA',
      ],
    },
    {
      template: 'MOTOS',
      termos: [
        'VEICULOS MOTOCICLETA',
        'MOTOCICLETA',
        'GRUPO 3',
        'MOTOS',
        'MOTO',
      ],
    },
    {
      template: 'CAMINHOES',
      termos: ['VEICULOS CAMINHOES', 'CAMINHOES', 'CAMINHÃO', 'GRUPO 4'],
    },
  ],
  templatePadrao: 'VEICULOS_LEVES',
  boleto: {
    codigoConta: 27,
    codigoTipoBoleto: 2,
    // 20 = aguardando reativação: tira o veículo do fluxo de revistoria do
    // app até o pagamento.
    situacaoVeiculoAposBoleto: 20,
    situacaoVeiculoAposPagamento: 1,
    situacaoAssociadoAposPagamento: 1,
    encargosPorAtraso: null,
  },
};

/**
 * Regra da Hertz (VPS própria, `TENANT_BASES=HERTZ`).
 * Situações de veículo/associado no SGA da Hertz: 1 ATIVO, 4 INADIMPLENTE
 * (não há situação 20 nem "PENDENTE DE PAGAMENTO").
 */
export const REGRA_HERTZ: RegraRevistoria = {
  perfil: 'HERTZ',
  situacoes: ['INADIMPLENTE'],
  modoComparacaoTipo: 'exato',
  mapeamentos: [
    {
      template: 'VEICULOS_LEVES',
      termos: [
        'AUTOMOVEL LEVE',
        'AUTOMOVEL LEVES',
        'CAMIONETAS, UTILITARIOS, HIBRIDOS E TROLLER',
      ],
    },
    {
      template: 'CAMINHOES',
      termos: ['MICRO-ONIBUS, MINIBUS E CAMINHOES'],
    },
    {
      template: 'MOTOS',
      termos: ['MOTOCICLETA'],
    },
  ],
  templatePadrao: 'VEICULOS_LEVES',
  boleto: {
    ...REGRA_PADRAO.boleto,
    codigoConta: 2,
    // Sem situação equivalente à 20: o veículo segue INADIMPLENTE até o
    // pagamento; o app da Hertz trata a revistoria APROVADA como
    // "aguardando pagamento".
    situacaoVeiculoAposBoleto: null,
    // Regra da Hertz (nov/2026): depois do vencimento do último boleto em
    // aberto, multa de 2% (uma vez, sobre o valor base) + mora de 0,5% ao
    // dia (sobre o valor base). O boleto em aberto é cancelado: o de
    // reativação o substitui.
    encargosPorAtraso: {
      multaPercentual: 2,
      moraDiariaPercentual: 0.5,
      cancelarBoletoEmAberto: true,
    },
  },
};

/** Regras específicas por base. Bases ausentes usam `REGRA_PADRAO`. */
const REGRAS_POR_BASE: Record<string, RegraRevistoria> = {
  HERTZ: REGRA_HERTZ,
};

/** Maiúsculas, sem acentos, sem espaços nas pontas e sem espaços repetidos. */
export function normalizarTextoRegra(valor: unknown): string {
  if (typeof valor !== 'string' && typeof valor !== 'number') return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Regra de revistoria da base.
 *
 * A base precisa ser uma das configuradas neste deploy: ausente ou
 * desconhecida lança `BaseNaoResolvidaError` (422). Antes, sem base, a função
 * devolvia a regra da base padrão do deploy — e a operação do associado
 * seguia com a regra (situações, template, conta do boleto) de outra base
 * sem ninguém perceber.
 *
 * Quem lista regras para o painel (`GET /reinspection/regras`, log do boot)
 * percorre `TENANT.baseNames` e nunca passou base ausente, então não muda.
 * Base configurada sem entrada em `REGRAS_POR_BASE` segue em `REGRA_PADRAO`.
 */
export function getRegraRevistoria(
  baseOrigin?: BaseOrigin | null,
): RegraRevistoria {
  const base = exigirBase(baseOrigin, 'regra de revistoria');
  return REGRAS_POR_BASE[normalizarTextoRegra(base)] ?? REGRA_PADRAO;
}

/** Indica se a situação do veículo no SGA obriga a revistoria nesta base. */
export function situacaoExigeRevistoria(
  situacao: unknown,
  baseOrigin?: BaseOrigin | null,
): boolean {
  const alvo = normalizarTextoRegra(situacao);
  if (!alvo) return false;
  return getRegraRevistoria(baseOrigin).situacoes.some(
    (s) => normalizarTextoRegra(s) === alvo,
  );
}

/**
 * Template de fotos para o `tipo` do veículo no SGA, conforme a regra da base.
 * Tipo vazio ou desconhecido cai no `templatePadrao` da regra.
 */
export function resolverTemplateRevistoria(
  tipo: unknown,
  baseOrigin?: BaseOrigin | null,
): TemplateRevistoria {
  const regra = getRegraRevistoria(baseOrigin);
  if (!normalizarTextoRegra(tipo)) return regra.templatePadrao;

  // `contem` reproduz byte a byte o `mapTipoToVehicleType` legado do app
  // (só maiúsculas, sem tratar acentos); `exato` normaliza os dois lados.
  const casa =
    regra.modoComparacaoTipo === 'exato'
      ? (termo: string) =>
          normalizarTextoRegra(tipo) === normalizarTextoRegra(termo)
      : (termo: string) =>
          normalizarTextoRegra(tipo) !== '' &&
          String(tipo as string)
            .toUpperCase()
            .includes(termo);

  const mapeamento = regra.mapeamentos.find((m) => m.termos.some(casa));
  return mapeamento?.template ?? regra.templatePadrao;
}

/** Visão serializável da regra, consumida pelo app e pelo painel. */
export function descreverRegraRevistoria(baseOrigin: BaseOrigin) {
  const regra = getRegraRevistoria(baseOrigin);
  const tiposPorTemplate: Record<TemplateRevistoria, string[]> = {
    VEICULOS_LEVES: [],
    MOTOS: [],
    CAMINHOES: [],
  };
  for (const m of regra.mapeamentos) {
    tiposPorTemplate[m.template].push(...m.termos);
  }
  return {
    baseOrigin,
    perfil: regra.perfil,
    situacoesRevistoria: [...regra.situacoes],
    modoComparacaoTipo: regra.modoComparacaoTipo,
    tiposPorTemplate,
    templatePadrao: regra.templatePadrao,
  };
}
