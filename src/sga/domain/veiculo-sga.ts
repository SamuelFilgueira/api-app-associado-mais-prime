/**
 * Veículos como o SGA (Hinova) os devolve em `GET /associado/buscar/{cpf}`.
 * Funções puras: decidem o que o associado pode ver, sem I/O.
 */

export type SgaVeiculo = {
  chassi?: string;
  placa?: string;
  codigo_veiculo?: string | number;
  situacao?: string | number;
  descricao_situacao?: string;
};

export type SgaAssociadoResponse = {
  veiculos?: SgaVeiculo[];
};

/** Situação do veículo no SGA que não deve ser exposta ao associado. */
const SITUACAO_VEICULO_INATIVO = 'INATIVO';

/**
 * Indica se o veículo está INATIVO no SGA. A Hinova devolve a situação em
 * `descricao_situacao` (texto) e, em alguns retornos, só em `situacao`;
 * a comparação é feita em ambos, sem distinguir caixa/espaços.
 */
export function veiculoInativoNoSga(veiculo: SgaVeiculo | null | undefined) {
  if (!veiculo) return false;
  const normalizar = (valor: string | number | null | undefined) =>
    String(valor ?? '')
      .trim()
      .toUpperCase();
  return (
    normalizar(veiculo.descricao_situacao) === SITUACAO_VEICULO_INATIVO ||
    normalizar(veiculo.situacao) === SITUACAO_VEICULO_INATIVO
  );
}

/**
 * Remove do corpo do SGA os veículos INATIVOS, mantendo o restante do payload
 * intacto. Não altera o objeto original (o mesmo corpo é compartilhado entre
 * requisições em voo e fica guardado no cache das leituras).
 */
export function removerVeiculosInativos<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const corpo = data as SgaAssociadoResponse;
  if (!Array.isArray(corpo.veiculos)) return data;
  return {
    ...corpo,
    veiculos: corpo.veiculos.filter((v) => !veiculoInativoNoSga(v)),
  } as T;
}

/**
 * Lista de veículos de um 2xx de `associado/buscar`, ou `null` quando o corpo
 * não é o esperado (corpo de erro, HTML de proxy, JSON truncado). Um 2xx sem
 * a lista NÃO é "associado sem veículos": sincronizar com ele desativaria
 * todos os veículos locais do usuário.
 */
export function listaDeVeiculosDoSga(data: unknown): SgaVeiculo[] | null {
  const corpo = data as SgaAssociadoResponse | null | undefined;
  if (!corpo || typeof corpo !== 'object' || !Array.isArray(corpo.veiculos)) {
    return null;
  }
  return corpo.veiculos;
}
