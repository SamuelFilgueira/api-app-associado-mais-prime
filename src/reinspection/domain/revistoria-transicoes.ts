import type { ReinspectionStatus } from '@prisma/client';
import { DomainError } from 'src/shared/erros/erros';

/**
 * Máquina de estados da revistoria.
 *
 * A tabela foi DERIVADA dos pontos que gravavam `Reinspection.status` e de
 * quem os chama (app do associado e painel). Cada aresta abaixo existe num
 * fluxo real; o que ficou de fora só acontecia por corrida ou por tela
 * defasada (ex.: aprovar uma foto depois da aprovação rebaixava a revistoria
 * para EM_ANALISE).
 *
 * | De         | Para       | Quem faz                                                    |
 * |------------|------------|-------------------------------------------------------------|
 * | PENDENTE   | EM_ANALISE | app: `PATCH /status` após o submit; painel: aprovar foto      |
 * | PENDENTE   | APROVADA   | painel: `PATCH /aprovar` (a tela libera PENDENTE)             |
 * | PENDENTE   | REPROVADA  | painel: reprovar foto                                         |
 * | PENDENTE   | FINALIZADA | app: `PATCH /finalizar` (veículo voltou a ATIVO)              |
 * | EM_ANALISE | APROVADA   | painel: `PATCH /aprovar`                                      |
 * | EM_ANALISE | REPROVADA  | painel: reprovar foto; aprovar foto com outra ainda reprovada |
 * | EM_ANALISE | FINALIZADA | app: `PATCH /finalizar`                                       |
 * | REPROVADA  | EM_ANALISE | app: reenvio de foto e `PATCH /status`; painel: reaprovar foto|
 * | REPROVADA  | FINALIZADA | app: `PATCH /finalizar`                                       |
 * | APROVADA   | REPROVADA  | painel: reprovar foto depois da aprovação (reaprovação)       |
 * | APROVADA   | FINALIZADA | app: `PATCH /finalizar`                                       |
 *
 * FINALIZADA é terminal: o veículo voltou a ATIVO e a próxima revistoria é
 * uma linha nova.
 */
export const TRANSICOES_PERMITIDAS: Readonly<
  Record<ReinspectionStatus, readonly ReinspectionStatus[]>
> = {
  PENDENTE: ['EM_ANALISE', 'APROVADA', 'REPROVADA', 'FINALIZADA'],
  EM_ANALISE: ['APROVADA', 'REPROVADA', 'FINALIZADA'],
  REPROVADA: ['EM_ANALISE', 'FINALIZADA'],
  APROVADA: ['REPROVADA', 'FINALIZADA'],
  FINALIZADA: [],
};

export const TODOS_OS_STATUS = Object.keys(
  TRANSICOES_PERMITIDAS,
) as ReinspectionStatus[];

/**
 * Estados de origem aceitos por cada operação. Todo par `origem → destino`
 * daqui precisa estar em `TRANSICOES_PERMITIDAS` (o spec do domínio confere).
 */
export const ORIGENS = {
  /** `PATCH /status` e reenvio de foto reprovada → EM_ANALISE. */
  MARCAR_EM_ANALISE: ['PENDENTE', 'REPROVADA'],
  /** `PATCH /finalizar` → FINALIZADA. */
  FINALIZAR: ['PENDENTE', 'EM_ANALISE', 'APROVADA', 'REPROVADA'],
  /**
   * `PATCH /aprovar` → APROVADA. REPROVADA fica de fora de propósito: é o
   * que impede a aprovação de vencer uma reprovação de foto simultânea.
   */
  APROVAR: ['PENDENTE', 'EM_ANALISE'],
  /** Reprovar foto → REPROVADA. */
  REPROVAR_POR_FOTO: ['PENDENTE', 'EM_ANALISE', 'APROVADA'],
} as const satisfies Record<string, readonly ReinspectionStatus[]>;

/**
 * Estados em que a revistoria ainda está sendo avaliada: aprovar uma foto
 * recalcula o status (EM_ANALISE ou REPROVADA). Fora deles (APROVADA,
 * FINALIZADA) aprovar foto não mexe na revistoria.
 */
const EM_AVALIACAO: readonly ReinspectionStatus[] = [
  'PENDENTE',
  'EM_ANALISE',
  'REPROVADA',
];

export const CODIGO_TRANSICAO_INVALIDA = 'REVISTORIA_TRANSICAO_INVALIDA';

export function transicaoPermitida(
  de: ReinspectionStatus,
  para: ReinspectionStatus,
): boolean {
  return TRANSICOES_PERMITIDAS[de].includes(para);
}

/**
 * Erro de programação, não de negócio: um caso de uso pediu uma transição
 * que a tabela não tem. Falha alto no primeiro teste em vez de abrir uma
 * aresta nova sem ninguém decidir.
 */
export function exigirArestasNaTabela(
  de: readonly ReinspectionStatus[],
  para: ReinspectionStatus,
): void {
  const fora = de.filter((origem) => !transicaoPermitida(origem, para));
  if (fora.length > 0) {
    throw new Error(
      `Transição de revistoria fora da tabela: ${fora.join(', ')} → ${para}`,
    );
  }
}

export function estaEmAvaliacao(status: ReinspectionStatus): boolean {
  return EM_AVALIACAO.includes(status);
}

/** Status da revistoria em avaliação depois de uma foto ser aprovada. */
export function statusAposAprovarFoto(
  haOutraFotoReprovada: boolean,
): Extract<ReinspectionStatus, 'REPROVADA' | 'EM_ANALISE'> {
  return haOutraFotoReprovada ? 'REPROVADA' : 'EM_ANALISE';
}

/** 409 devolvido quando o estado atual não admite a transição pedida. */
export function erroDeTransicaoInvalida(
  atual: ReinspectionStatus,
  para: ReinspectionStatus,
): DomainError {
  return new DomainError(
    CODIGO_TRANSICAO_INVALIDA,
    `A revistoria está ${atual} e não pode passar para ${para}.`,
    { status: 409, detalhes: { statusAtual: atual, statusPretendido: para } },
  );
}
