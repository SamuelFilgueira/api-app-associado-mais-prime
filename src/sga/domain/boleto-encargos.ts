import type { RegraEncargosPorAtraso } from 'src/config/revistoria-regra.config';
import { pertenceAoVeiculo } from 'src/sga/domain/boleto-adocao';
import type { BoletoSgaCru } from 'src/sga/domain/boleto-sga.parser';
import { SITUACAO_BOLETO_ABERTO } from 'src/sga/domain/boleto-situacao';

/**
 * Encargos por atraso do boleto de reativação (regra por empresa — hoje só a
 * Hertz, ver `REGRA_HERTZ.boleto.encargosPorAtraso`).
 *
 *   total = base + multa + mora
 *   multa = base × multa%          (UMA vez, só se houver atraso; nunca por dia)
 *   mora  = base × mora% × dias    (por dia de atraso, sempre sobre o valor base)
 *
 * `base` é o valor de sempre do boleto de reativação (produtos ativos + taxa
 * administrativa). `dias` conta do vencimento do ÚLTIMO BOLETO EM ABERTO do
 * veículo até o dia em que o boleto novo é gerado.
 *
 * Funções puras: contas em centavos (inteiros), datas só com dia/mês/ano.
 */

/** A listagem do SGA aceita no máximo 90 dias por consulta. */
export const DIAS_POR_JANELA_DE_BUSCA = 90;
/** Até onde voltar atrás do boleto em aberto: 4 janelas = 360 dias. */
export const JANELAS_DE_BUSCA = 4;

const DIA_MS = 86_400_000;

/** Boleto em aberto que serve de base para o atraso. */
export interface BoletoEmAberto {
  nossoNumero: string;
  /** Vencimento vigente do boleto (meia-noite local). */
  vencimento: Date;
  /** `valor_boleto` como o SGA devolveu, só para o registro. */
  valor: string | null;
  codigoTipoBoleto: string | null;
  /** `quantidade_dias_vencidos` do SGA, só para conferência no log. */
  diasVencidosNoSga: number | null;
}

/** Resultado do cálculo, em centavos. */
export interface EncargosCalculados {
  baseCentavos: number;
  multaCentavos: number;
  moraCentavos: number;
  totalCentavos: number;
  diasDeAtraso: number;
}

/** Situação do cancelamento do boleto que serviu de base. */
export type SituacaoDoCancelamento =
  /** Nada a cancelar (não havia boleto em aberto, ou a regra não cancela). */
  | 'NAO_APLICAVEL'
  | 'CANCELADO'
  /** O SGA não foi acionado ou recusou: alguém precisa cancelar à mão. */
  | 'PENDENTE_MANUAL';

/** O que fica gravado em `ReinspectionPayment.encargos` (auditoria). */
export interface RegistroDeEncargos {
  regra: { multaPercentual: number; moraDiariaPercentual: number };
  valorBase: string;
  multa: string;
  mora: string;
  valorTotal: string;
  diasDeAtraso: number;
  /**
   * Data (AAAA-MM-DD) a partir da qual o atraso é contado. É o vencimento do
   * boleto em aberto — ou, se ele próprio já era um boleto de reativação
   * gerado com encargos, a data de referência que ELE carregava (o atraso não
   * recomeça do zero quando um boleto de reativação vence sem pagamento).
   */
  vencimentoDeReferencia: string | null;
  boletoAnterior: {
    nossoNumero: string;
    vencimento: string;
    valor: string | null;
    codigoTipoBoleto: string | null;
  } | null;
  cancelamento: {
    situacao: SituacaoDoCancelamento;
    motivo: string | null;
    em: string | null;
  };
}

/**
 * Data do SGA em `AAAA-MM-DD` (formato das listagens) ou `DD/MM/AAAA`
 * (formato dos filtros), como meia-noite local. `null` se não for data.
 */
export function lerDataDoSga(valor: unknown): Date | null {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  const [ano, mes, dia] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : br
      ? [Number(br[3]), Number(br[2]), Number(br[1])]
      : [NaN, NaN, NaN];
  if (!Number.isInteger(ano)) return null;

  const data = new Date(ano, mes - 1, dia);
  // Rejeita data que o construtor "rola" (31/02 → março).
  return data.getFullYear() === ano &&
    data.getMonth() === mes - 1 &&
    data.getDate() === dia
    ? data
    : null;
}

/** `AAAA-MM-DD` de uma data local. */
export function dataIso(data: Date): string {
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}

/**
 * Dias corridos entre o vencimento e hoje, olhando só dia/mês/ano (a hora e
 * o horário de verão não contam). Vencimento hoje ou no futuro = 0.
 */
export function diasDeAtraso(vencimento: Date, hoje: Date): number {
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((utc(hoje) - utc(vencimento)) / DIA_MS));
}

/** Itens de uma listagem do SGA: lista direta ou objeto de chaves numéricas. */
export function itensDaListagem(resposta: unknown): BoletoSgaCru[] {
  const ehObjeto = (v: unknown): v is BoletoSgaCru =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(resposta)) return resposta.filter(ehObjeto);
  if (!ehObjeto(resposta)) return [];
  return Object.entries(resposta)
    .filter(([chave, valor]) => /^\d+$/.test(chave) && ehObjeto(valor))
    .map(([, valor]) => valor as BoletoSgaCru);
}

function escalar(valor: unknown): string | null {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor)
    : null;
}

/**
 * O ÚLTIMO boleto em aberto do veículo: situação ABERTO (2) e vencimento
 * até hoje, escolhendo o de vencimento mais recente (empate: o maior
 * `nosso_numero`). Boleto que ainda vai vencer não entra — não há atraso
 * nele, e cancelá-lo tiraria do associado uma cobrança futura legítima.
 *
 * Vale o vencimento vigente (`data_vencimento`); o original só quando o
 * vigente não vem.
 */
export function selecionarUltimoBoletoEmAberto(
  itens: unknown,
  filtro: { codigoVeiculo: string; hoje: Date },
): BoletoEmAberto | null {
  const candidatos: BoletoEmAberto[] = [];

  for (const item of itensDaListagem(itens)) {
    if (item.nosso_numero == null) continue;
    if (!pertenceAoVeiculo(item, filtro.codigoVeiculo)) continue;
    if (String(item.codigo_situacao_boleto ?? '') !== SITUACAO_BOLETO_ABERTO) {
      continue;
    }
    const vencimento =
      lerDataDoSga(item.data_vencimento) ??
      lerDataDoSga(item.data_vencimento_original);
    if (!vencimento || vencimento.getTime() > filtro.hoje.getTime()) continue;

    const dias = Number(item.quantidade_dias_vencidos);
    candidatos.push({
      nossoNumero: String(item.nosso_numero),
      vencimento,
      valor: escalar(item.valor_boleto),
      codigoTipoBoleto: escalar(item.codigo_tipo_boleto),
      diasVencidosNoSga:
        item.quantidade_dias_vencidos != null && Number.isFinite(dias)
          ? dias
          : null,
    });
  }
  if (candidatos.length === 0) return null;

  candidatos.sort(
    (a, b) =>
      b.vencimento.getTime() - a.vencimento.getTime() ||
      Number(b.nossoNumero) - Number(a.nossoNumero),
  );
  return candidatos[0];
}

/** Valor base (reais, como número) → centavos inteiros. */
export function paraCentavos(valorEmReais: number): number {
  return Math.round(valorEmReais * 100);
}

/** Centavos → `1234.56` (ponto decimal, para registro). */
export function centavosParaTexto(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/**
 * Multa e mora sobre o valor base. Sem atraso (`dias = 0`) não há multa nem
 * mora: o total é o próprio valor base.
 */
export function calcularEncargos(params: {
  baseCentavos: number;
  dias: number;
  regra: Pick<
    RegraEncargosPorAtraso,
    'multaPercentual' | 'moraDiariaPercentual'
  >;
}): EncargosCalculados {
  const { baseCentavos, regra } = params;
  const dias = Math.max(0, Math.trunc(params.dias));

  const multaCentavos =
    dias > 0 ? Math.round((baseCentavos * regra.multaPercentual) / 100) : 0;
  const moraCentavos = Math.round(
    (baseCentavos * regra.moraDiariaPercentual * dias) / 100,
  );
  return {
    baseCentavos,
    multaCentavos,
    moraCentavos,
    totalCentavos: baseCentavos + multaCentavos + moraCentavos,
    diasDeAtraso: dias,
  };
}

/** Monta o registro de auditoria que acompanha o boleto gerado. */
export function montarRegistroDeEncargos(params: {
  regra: Pick<
    RegraEncargosPorAtraso,
    'multaPercentual' | 'moraDiariaPercentual'
  >;
  calculo: EncargosCalculados;
  boletoAnterior: BoletoEmAberto | null;
  vencimentoDeReferencia: Date | null;
}): RegistroDeEncargos {
  const { calculo, boletoAnterior } = params;
  return {
    regra: {
      multaPercentual: params.regra.multaPercentual,
      moraDiariaPercentual: params.regra.moraDiariaPercentual,
    },
    valorBase: centavosParaTexto(calculo.baseCentavos),
    multa: centavosParaTexto(calculo.multaCentavos),
    mora: centavosParaTexto(calculo.moraCentavos),
    valorTotal: centavosParaTexto(calculo.totalCentavos),
    diasDeAtraso: calculo.diasDeAtraso,
    vencimentoDeReferencia: params.vencimentoDeReferencia
      ? dataIso(params.vencimentoDeReferencia)
      : null,
    boletoAnterior: boletoAnterior
      ? {
          nossoNumero: boletoAnterior.nossoNumero,
          vencimento: dataIso(boletoAnterior.vencimento),
          valor: boletoAnterior.valor,
          codigoTipoBoleto: boletoAnterior.codigoTipoBoleto,
        }
      : null,
    cancelamento: { situacao: 'NAO_APLICAVEL', motivo: null, em: null },
  };
}

/**
 * Data de referência gravada num registro de encargos anterior (o boleto em
 * aberto era um boleto de reativação gerado por esta API). `null` se o valor
 * guardado não tiver o formato esperado.
 */
export function referenciaGravada(registro: unknown): Date | null {
  if (!registro || typeof registro !== 'object') return null;
  return lerDataDoSga(
    (registro as { vencimentoDeReferencia?: unknown }).vencimentoDeReferencia,
  );
}
