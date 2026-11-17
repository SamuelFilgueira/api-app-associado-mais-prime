import { veiculoPermiteAcesso } from 'src/associado/helpers/acesso-app.helper';

/**
 * Regra pura da inscrição no produto "Associado da Sorte" do SGA: o veículo
 * precisa permitir acesso ao app e ter um produto com o código E a
 * descrição configurados, com `situacao` ATIVO.
 */

/** Sem acento, sem espaços nas pontas, espaços internos únicos, maiúsculas. */
export function normalizarTextoSga(valor: unknown): string {
  if (typeof valor !== 'string' && typeof valor !== 'number') return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export interface ProdutoSga {
  codigo_produto?: unknown;
  descricao?: unknown;
  situacao?: unknown;
}

export interface ProdutoSorteConfig {
  codigo: string;
  descricao: string;
}

export function produtoInscreve(
  produto: ProdutoSga | null | undefined,
  alvo: ProdutoSorteConfig,
): boolean {
  if (!produto) return false;
  return (
    normalizarTextoSga(produto.codigo_produto) ===
      normalizarTextoSga(alvo.codigo) &&
    normalizarTextoSga(produto.descricao) ===
      normalizarTextoSga(alvo.descricao) &&
    normalizarTextoSga(produto.situacao) === 'ATIVO'
  );
}

export interface VeiculoSga {
  codigo_veiculo?: unknown;
  situacao?: string | number | null;
  descricao_situacao?: string | null;
}

/** Veículos que permitem acesso ao app e têm código (candidatos a consultar). */
export function veiculosCandidatos(veiculos: unknown): VeiculoSga[] {
  if (!Array.isArray(veiculos)) return [];
  return (veiculos as VeiculoSga[]).filter(
    (v) =>
      veiculoPermiteAcesso(v) && normalizarTextoSga(v?.codigo_veiculo) !== '',
  );
}
