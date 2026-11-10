/**
 * Regra de acesso ao app por situação do associado/veículo no SGA (Hinova).
 *
 * Funções puras (sem I/O). Usadas tanto no login (`verificarSituacao`) quanto
 * no cadastro inicial (`primeiroAcesso`), para que as duas portas de entrada
 * apliquem exatamente a mesma regra.
 *
 * - Associado `ATIVO`, `INADIMPLENTE` ou `INADIMPLENTE 20 DIAS`: acessa.
 * - Associado `PENDENTE DE PAGAMENTO`: acessa somente se ao menos um veículo
 *   estiver em uma das situações acima (o app já restringe cada veículo
 *   conforme a situação dele). Com um único veículo fora dessas situações —
 *   ou nenhum veículo elegível entre vários — o acesso é bloqueado.
 * - Qualquer outra situação do associado: bloqueado.
 */

/** Situações (do associado ou do veículo) que dão acesso ao app. */
export const SITUACOES_COM_ACESSO_AO_APP = [
  'ATIVO',
  'INADIMPLENTE 20 DIAS',
  'INADIMPLENTE',
] as const;

/** Situação do associado cujo acesso depende da situação dos veículos. */
export const SITUACAO_ASSOCIADO_PENDENTE_PAGAMENTO = 'PENDENTE DE PAGAMENTO';

/** Recorte do veículo devolvido pelo SGA em `GET /associado/buscar/{cpf}`. */
export type VeiculoSituacaoSga = {
  situacao?: string | number | null;
  descricao_situacao?: string | null;
};

function normalizarSituacao(valor: unknown): string {
  if (typeof valor !== 'string' && typeof valor !== 'number') return '';
  return String(valor).trim().replace(/\s+/g, ' ').toUpperCase();
}

function situacaoDaAcesso(valor: unknown): boolean {
  return (SITUACOES_COM_ACESSO_AO_APP as readonly string[]).includes(
    normalizarSituacao(valor),
  );
}

/** Associado em situação que, por si só, dá acesso ao app. */
export function situacaoAssociadoPermiteAcesso(situacao: unknown): boolean {
  return situacaoDaAcesso(situacao);
}

/** Associado `PENDENTE DE PAGAMENTO`: o acesso depende dos veículos. */
export function associadoPendenteDePagamento(situacao: unknown): boolean {
  return normalizarSituacao(situacao) === SITUACAO_ASSOCIADO_PENDENTE_PAGAMENTO;
}

/**
 * Veículo em situação que dá acesso ao app. A Hinova devolve o texto em
 * `situacao` e, em alguns retornos, em `descricao_situacao`; vale qualquer
 * um dos dois.
 */
export function veiculoPermiteAcesso(
  veiculo: VeiculoSituacaoSga | null | undefined,
): boolean {
  if (!veiculo) return false;
  return (
    situacaoDaAcesso(veiculo.descricao_situacao) ||
    situacaoDaAcesso(veiculo.situacao)
  );
}

/** Indica se há ao menos um veículo em situação que dá acesso ao app. */
export function algumVeiculoPermiteAcesso(veiculos: unknown): boolean {
  if (!Array.isArray(veiculos)) return false;
  return (veiculos as VeiculoSituacaoSga[]).some(veiculoPermiteAcesso);
}

/**
 * Decisão completa quando a situação do associado e os veículos já estão em
 * mãos (corpo de `GET /associado/buscar/{cpf}`).
 */
export function associadoPodeAcessarApp(
  situacaoAssociado: unknown,
  veiculos: unknown,
): boolean {
  if (situacaoAssociadoPermiteAcesso(situacaoAssociado)) return true;
  if (associadoPendenteDePagamento(situacaoAssociado)) {
    return algumVeiculoPermiteAcesso(veiculos);
  }
  return false;
}
