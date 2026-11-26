/**
 * Leitura das respostas do SGA (Hinova) usadas no boleto de reativação.
 * Funções puras: recebem o corpo como veio e devolvem só o que o fluxo usa.
 *
 * A Hinova não mantém um formato único — o mesmo endpoint já devolveu array,
 * objeto com chaves numéricas e objeto embrulhado. Cada leitor abaixo aceita
 * exatamente os formatos que o fluxo já aceitava; nada aqui "adivinha" um
 * boleto que a resposta não trouxe.
 */

/** Item de boleto como o SGA devolve (cadastro, consulta ou listagem). */
export type BoletoSgaCru = {
  nosso_numero?: number | string;
  linha_digitavel?: string;
  link_boleto?: string;
  codigo_situacao_boleto?: number | string;
  codigo_tipo_boleto?: number | string;
  data_vencimento_original?: string;
  data_vencimento?: string;
  veiculos?: Array<{ codigo_veiculo?: number | string }>;
  codigo_veiculo?: number | string;
  [key: string]: unknown;
};

export interface DadosAssociadoBoleto {
  codigoAssociado: number;
  codigoRegional?: number;
  nome?: string;
  telefoneCelular?: string;
}

export interface ProdutosDoVeiculo {
  valorTotalProdutosAtivo: number;
  taxaAdministrativa: string;
  codigoVeiculo?: string;
}

export interface BoletoIdentificado {
  nossoNumero: string | null;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
}

/** Converte número/string do SGA em string; objetos/nulos viram undefined. */
export function escalarParaString(valor: unknown): string | undefined {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'bigint') {
    return String(valor);
  }
  return undefined;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return !!valor && typeof valor === 'object';
}

/** Primeiro registro de um corpo que pode vir como objeto ou como lista. */
function primeiroRegistro(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    return ehObjeto(data[0]) ? data[0] : {};
  }
  return ehObjeto(data) ? data : {};
}

/**
 * Formatos em que o SGA embrulha uma lista de boletos: array direto,
 * `{ dados_boleto_inserido: [...] }` ou `{ "0": {...}, mensagem }`.
 * `null` = nenhum deles.
 */
function listaEmbrulhada(input: unknown): BoletoSgaCru[] | null {
  if (Array.isArray(input)) {
    return input.filter((item): item is BoletoSgaCru => ehObjeto(item));
  }
  if (!ehObjeto(input)) return null;

  if (Array.isArray(input.dados_boleto_inserido)) {
    return input.dados_boleto_inserido.filter((item): item is BoletoSgaCru =>
      ehObjeto(item),
    );
  }
  const porChaveNumerica = Object.entries(input)
    .filter(([chave, valor]) => /^\d+$/.test(chave) && ehObjeto(valor))
    .map(([, valor]) => valor as BoletoSgaCru);
  return porChaveNumerica.length > 0 ? porChaveNumerica : null;
}

function identificar(boleto: BoletoSgaCru | undefined): BoletoIdentificado {
  return {
    nossoNumero:
      boleto?.nosso_numero != null ? String(boleto.nosso_numero) : null,
    linhaDigitavel:
      typeof boleto?.linha_digitavel === 'string'
        ? boleto.linha_digitavel
        : null,
    linkBoleto:
      typeof boleto?.link_boleto === 'string' ? boleto.link_boleto : null,
  };
}

/** Boletos da resposta de `POST /boleto/cadastrar`. */
export function boletosCadastrados(input: unknown): BoletoSgaCru[] {
  if (!input) return [];
  return listaEmbrulhada(input) ?? [];
}

/**
 * Boleto recém-cadastrado. `encontrado = false` quando o 2xx não trouxe os
 * dados em nenhum formato conhecido (os três campos saem nulos).
 */
export function lerBoletoCadastrado(
  input: unknown,
): BoletoIdentificado & { encontrado: boolean } {
  const boleto = boletosCadastrados(input)[0];
  return { ...identificar(boleto), encontrado: !!boleto };
}

/**
 * Boletos da resposta de `POST /processa-pdf/boleto`. Além dos formatos do
 * cadastro, aceita o objeto solto (`{ codigo_situacao_boleto, ... }`) e o
 * corpo em texto JSON.
 */
export function boletosDaConsulta(input: unknown): BoletoSgaCru[] {
  if (!input) return [];
  if (typeof input === 'string') {
    try {
      return boletosDaConsulta(JSON.parse(input));
    } catch {
      return [];
    }
  }
  const lista = listaEmbrulhada(input);
  if (lista) return lista;
  return ehObjeto(input) ? [input as BoletoSgaCru] : [];
}

export interface SituacaoLida {
  /** `codigo_situacao_boleto` como texto; `undefined` = a resposta não trouxe. */
  codigoSituacao: string | undefined;
  boleto: BoletoSgaCru | undefined;
}

function situacaoDe(boleto: BoletoSgaCru | undefined): string | undefined {
  const cru = boleto?.codigo_situacao_boleto;
  return cru !== undefined && cru !== null ? String(cru) : undefined;
}

/**
 * Situação do boleto na resposta de `processa-pdf/boleto`: o item com o
 * mesmo `nosso_numero` ou, se nenhum casar, o primeiro (a consulta já foi
 * feita por `nosso_numero` e há formatos em que o item não o repete).
 */
export function lerSituacaoDaConsulta(
  input: unknown,
  nossoNumero: string | number,
): SituacaoLida {
  const boletos = boletosDaConsulta(input);
  const boleto =
    boletos.find(
      (item) => String(item?.nosso_numero) === String(nossoNumero),
    ) ?? boletos[0];
  return { codigoSituacao: situacaoDe(boleto), boleto };
}

/**
 * Situação do boleto na listagem por veículo (`listar/boleto-associado-veiculo`),
 * usada quando `processa-pdf` não informa a situação. Aqui a lista traz todos
 * os boletos do veículo: só vale o item com o `nosso_numero` exato.
 */
export function lerSituacaoDaListagem(
  input: unknown,
  nossoNumero: string | number,
): SituacaoLida & { encontrados: number } {
  if (!Array.isArray(input)) {
    return { codigoSituacao: undefined, boleto: undefined, encontrados: 0 };
  }
  const boleto = (input as BoletoSgaCru[]).find(
    (item) => String(item?.nosso_numero) === String(nossoNumero),
  );
  return {
    codigoSituacao:
      boleto?.codigo_situacao_boleto !== undefined
        ? String(boleto.codigo_situacao_boleto)
        : undefined,
    boleto,
    encontrados: input.length,
  };
}

/** Dados do associado (`associado/buscar`) usados no boleto e nos avisos. */
export function lerAssociadoParaBoleto(
  data: unknown,
): DadosAssociadoBoleto | null {
  const raw = primeiroRegistro(data);
  const codigoAssociado =
    raw.codigo_associado != null ? Number(raw.codigo_associado) : undefined;
  if (!codigoAssociado) return null;

  return {
    codigoAssociado,
    codigoRegional:
      raw.codigo_regional != null ? Number(raw.codigo_regional) : undefined,
    nome: typeof raw.nome === 'string' ? raw.nome : undefined,
    telefoneCelular:
      typeof raw.telefone_celular === 'string'
        ? raw.telefone_celular
        : undefined,
  };
}

/** Valores de `produto-vinculado-veiculo/listar` usados no boleto. */
export function lerProdutosDoVeiculo(data: unknown): ProdutosDoVeiculo {
  const raw = primeiroRegistro(data);
  return {
    valorTotalProdutosAtivo: Number(raw.valor_total_produtos_ativo_reais ?? 0),
    taxaAdministrativa: escalarParaString(raw.taxa_administrativa) ?? '0',
    codigoVeiculo: escalarParaString(raw.codigo_veiculo),
  };
}

/**
 * `nosso_numero` no formato em que o fluxo sempre o enviou ao SGA (número).
 * Um valor que não cabe em um inteiro seguro segue como texto, sem perder
 * dígitos.
 */
export function nossoNumeroParaSga(nossoNumero: string): number | string {
  return /^\d{1,15}$/.test(nossoNumero) ? Number(nossoNumero) : nossoNumero;
}
