import { parseDateBR } from 'src/shared/date.util';
import {
  BoletoIdentificado,
  BoletoSgaCru,
} from 'src/sga/domain/boleto-sga.parser';
import {
  SITUACAO_BOLETO_ABERTO,
  estadoDoBoleto,
} from 'src/sga/domain/boleto-situacao';

/**
 * Adoção: antes de cadastrar um boleto de reativação, a API procura no SGA um
 * que já exista para o veículo — criado à mão por uma operadora, ou criado
 * pela própria API numa tentativa cuja resposta se perdeu (timeout depois do
 * insert). Achando, usa esse em vez de cadastrar outro.
 *
 * Funções puras: recebem a listagem de `listar/boleto-associado-veiculo`.
 */

/** Referência da revistoria gravada no boleto que a API cadastra. */
export function referenciaDaRevistoria(reinspectionId: number): string {
  return `REV-${reinspectionId}`;
}

export type CriterioDaAdocao = 'REFERENCIA' | 'TIPO_E_SITUACAO';

export interface BoletoAdotavel extends BoletoIdentificado {
  nossoNumero: string;
  /** Por qual critério o boleto foi reconhecido. */
  criterio: CriterioDaAdocao;
}

export interface FiltroDeAdocao {
  codigoVeiculo: string;
  /** `codigo_tipo_boleto` de reativação na regra da base. */
  codigoTipoBoleto: number;
  /** Meia-noite (local) de hoje: boleto vencido antes disso não é adotado. */
  hoje: Date;
  /** `REV-<id>` da revistoria; ausente = só os critérios de tipo e situação. */
  referencia?: string;
}

function vencimentoDe(item: BoletoSgaCru): Date | null {
  return parseDateBR(item.data_vencimento_original ?? item.data_vencimento);
}

/**
 * O item é do veículo consultado? Sem identificador de veículo na resposta
 * vale a própria consulta, que já foi feita por `codigo_veiculo`.
 */
export function pertenceAoVeiculo(
  item: BoletoSgaCru,
  codigoVeiculo: string,
): boolean {
  if (item.codigo_veiculo != null) {
    return String(item.codigo_veiculo) === codigoVeiculo;
  }
  if (Array.isArray(item.veiculos) && item.veiculos.length > 0) {
    return item.veiculos.some(
      (v) =>
        v?.codigo_veiculo != null && String(v.codigo_veiculo) === codigoVeiculo,
    );
  }
  return true;
}

/**
 * A referência aparece em algum campo de texto do item? Procura a marca
 * inteira (`REV-12` não casa com `REV-123`) no item e nos objetos aninhados
 * (`referencia: [{ descricao }]`), sem depender do nome do campo em que o
 * SGA a devolve.
 */
export function contemReferencia(
  item: unknown,
  referencia: string,
  profundidade = 0,
): boolean {
  if (typeof item === 'string') {
    const marca = referencia.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${marca}($|[^A-Za-z0-9])`).test(item);
  }
  if (!item || typeof item !== 'object' || profundidade > 3) return false;
  return Object.values(item as Record<string, unknown>).some((valor) =>
    contemReferencia(valor, referencia, profundidade + 1),
  );
}

function adotavel(item: BoletoSgaCru, criterio: CriterioDaAdocao) {
  return {
    nossoNumero: String(item.nosso_numero),
    linhaDigitavel:
      typeof item.linha_digitavel === 'string' ? item.linha_digitavel : null,
    linkBoleto: typeof item.link_boleto === 'string' ? item.link_boleto : null,
    criterio,
  };
}

/**
 * Escolhe o boleto a adotar, ou `null` se a API deve cadastrar um novo.
 *
 * 1. Pela referência da revistoria (`REV-<id>`): é o boleto que a própria
 *    API cadastrou. Vale em aberto ou já pago — pago, a verificação de
 *    pagamento conclui a reativação; cancelado/excluído não é adotado.
 * 2. Pelos critérios de sempre: tipo de reativação, em ABERTO e com
 *    vencimento original de hoje em diante (o SGA não devolve a data de
 *    criação). Boleto de mensalidade (outro tipo) nunca é adotado. Havendo
 *    mais de um, o de vencimento mais próximo.
 */
export function selecionarBoletoParaAdocao(
  itens: unknown,
  filtro: FiltroDeAdocao,
): BoletoAdotavel | null {
  if (!Array.isArray(itens)) return null;

  const doVeiculo = (itens as BoletoSgaCru[]).filter(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      item.nosso_numero != null &&
      pertenceAoVeiculo(item, filtro.codigoVeiculo),
  );

  if (filtro.referencia) {
    const referencia = filtro.referencia;
    const comReferencia = doVeiculo.find(
      (item) =>
        contemReferencia(item, referencia) &&
        estadoDoBoleto(
          item.codigo_situacao_boleto != null
            ? String(item.codigo_situacao_boleto)
            : undefined,
        ) !== 'ENCERRADO',
    );
    if (comReferencia) return adotavel(comReferencia, 'REFERENCIA');
  }

  const candidatos = doVeiculo.filter((item) => {
    if (String(item.codigo_situacao_boleto ?? '') !== SITUACAO_BOLETO_ABERTO) {
      return false;
    }
    if (
      item.codigo_tipo_boleto == null ||
      Number(item.codigo_tipo_boleto) !== filtro.codigoTipoBoleto
    ) {
      return false;
    }
    const vencimento = vencimentoDe(item);
    return vencimento != null && vencimento.getTime() >= filtro.hoje.getTime();
  });
  if (candidatos.length === 0) return null;

  candidatos.sort(
    (a, b) =>
      (vencimentoDe(a)?.getTime() ?? 0) - (vencimentoDe(b)?.getTime() ?? 0),
  );
  return adotavel(candidatos[0], 'TIPO_E_SITUACAO');
}

/**
 * Boleto de `nosso_numero` conhecido (cadastrado pela API numa tentativa em
 * que a gravação local falhou): só o item com o número exato.
 */
export function localizarPorNossoNumero(
  itens: unknown,
  nossoNumero: string,
): BoletoIdentificado | null {
  if (!Array.isArray(itens)) return null;
  const item = (itens as BoletoSgaCru[]).find(
    (i) =>
      !!i && typeof i === 'object' && String(i.nosso_numero) === nossoNumero,
  );
  if (!item) return null;
  const {
    nossoNumero: numero,
    linhaDigitavel,
    linkBoleto,
  } = adotavel(item, 'REFERENCIA');
  return { nossoNumero: numero, linhaDigitavel, linkBoleto };
}
