import { formatDateBR } from 'src/shared/date.util';
import { TipoMensagem } from 'src/boleto-notificacao/domain/regua-tipos';

/** O que vale para todas as bases e etapas de uma rodada da régua. */
export interface ContextoDaRegua {
  /** "Hoje" da rotina, à meia-noite local. */
  dataReferencia: Date;
  tipos: TipoMensagem[];
  dryRun: boolean;
  origem: 'AGENDADA' | 'MANUAL';
}

export interface MetricasMomento {
  totalRegistrosSga: number;
  totalPaginasSga: number;
  totalBoletosElegiveis: number;
  totalAssociados: number;
  totalSemUsuario: number;
  totalSemToken: number;
  totalIdempotentes: number;
  totalDuplicadosUsuario: number;
  totalEnfileirados: number;
  totalEnviados: number;
  totalFalhas: number;
  totalTokensInvalidos: number;
  coberturaElegiveis: number | null;
  /**
   * Envios retomados de um log que não se completou (órfão `ENFILEIRADO` ou
   * falha de transporte). Só no resultado; não há coluna na execução.
   */
  totalReenvios: number;
  /**
   * Destinatários que terminaram a etapa SEM envio confirmado e ainda podem
   * receber: falha de transporte que persistiu, ou log `ENFILEIRADO` recente
   * de outra execução. Maior que zero = a régua da base não fechou.
   */
  totalPendentes: number;
}

/** Por que a base não foi executada nesta chamada. */
export type MotivoDoPulo =
  /** Outra execução da mesma base e data segura a trava. */
  | 'EXECUCAO_EM_CURSO'
  /** Este mesmo job já concluiu a base numa tentativa anterior. */
  | 'JA_CONCLUIDA';

export interface ResultadoMomento {
  tenant: string;
  tipo: TipoMensagem;
  dataReferencia: string;
  dataAlvo: string;
  gatilho: boolean;
  dryRun: boolean;
  execucaoId: number | null;
  status: 'PULADA' | 'CONCLUIDA' | 'FALHA' | 'DRY_RUN';
  /** Só quando `status` é `PULADA`. */
  motivoDoPulo?: MotivoDoPulo;
  origemDados?: 'SGA' | 'MOCK';
  metricas: MetricasMomento;
  erro?: string;
  amostraDestinatarios?: Array<{
    codigoAssociado: number;
    cpf: string;
    userId: number;
    quantidadeBoletos: number;
    nossoNumero: string;
    vencimento: string;
    titulo: string;
    corpo: string;
  }>;
}

export function metricasVazias(): MetricasMomento {
  return {
    totalRegistrosSga: 0,
    totalPaginasSga: 0,
    totalBoletosElegiveis: 0,
    totalAssociados: 0,
    totalSemUsuario: 0,
    totalSemToken: 0,
    totalIdempotentes: 0,
    totalDuplicadosUsuario: 0,
    totalEnfileirados: 0,
    totalEnviados: 0,
    totalFalhas: 0,
    totalTokensInvalidos: 0,
    coberturaElegiveis: null,
    totalReenvios: 0,
    totalPendentes: 0,
  };
}

/**
 * Resultado de uma etapa (base × tipo) no ponto de partida: `CONCLUIDA`, sem
 * execução e com as métricas zeradas. `desfecho` troca o status para a etapa
 * que nem chegou a rodar (base pulada, falha fora dela).
 */
export function resultadoDaEtapa(
  tenant: string,
  tipo: TipoMensagem,
  contexto: ContextoDaRegua,
  janela: { descricao: string },
  desfecho: Partial<
    Pick<ResultadoMomento, 'status' | 'erro' | 'motivoDoPulo'>
  > = {},
): ResultadoMomento {
  return {
    tenant,
    tipo,
    dataReferencia: formatDateBR(contexto.dataReferencia),
    dataAlvo: janela.descricao,
    gatilho: true,
    dryRun: contexto.dryRun,
    execucaoId: null,
    status: 'CONCLUIDA',
    metricas: metricasVazias(),
    ...desfecho,
  };
}

/** Razão com 4 casas; `null` quando não há denominador. */
export function cobertura(
  numerador: number,
  denominador: number,
): number | null {
  if (denominador <= 0) return null;
  return Math.round((numerador / denominador) * 10000) / 10000;
}

/** Como a régua de cada base terminou numa chamada. */
export interface AvaliacaoDaRegua {
  /** Data de referência usada (dd/mm/yyyy); `null` sem resultados. */
  dataReferencia: string | null;
  /** Consulta ao SGA ou alguma etapa terminou em `FALHA`. */
  basesEmFalha: Array<{ base: string; erro: string }>;
  /** Todas as etapas concluíram, mas sobraram envios sem confirmação. */
  basesComPendencia: Array<{ base: string; pendentes: number }>;
  /** Nada mais a fazer para a base nesta data. */
  basesConcluidas: string[];
  /** Há base em falha ou com pendência: vale repetir. */
  incompleta: boolean;
}

/**
 * Lê os resultados por etapa e diz, por base, se a régua fechou. Base pulada
 * por haver outra execução em curso não entra em nenhuma lista: quem segura
 * a trava é que responde por ela.
 */
export function avaliarRegua(resultados: ResultadoMomento[]): AvaliacaoDaRegua {
  const porBase = new Map<string, ResultadoMomento[]>();
  for (const resultado of resultados) {
    const lista = porBase.get(resultado.tenant) ?? [];
    lista.push(resultado);
    porBase.set(resultado.tenant, lista);
  }

  const avaliacao: AvaliacaoDaRegua = {
    dataReferencia: resultados[0]?.dataReferencia ?? null,
    basesEmFalha: [],
    basesComPendencia: [],
    basesConcluidas: [],
    incompleta: false,
  };

  for (const [base, etapas] of porBase) {
    const falha = etapas.find((e) => e.status === 'FALHA');
    if (falha) {
      avaliacao.basesEmFalha.push({
        base,
        erro: falha.erro ?? 'falha sem descrição',
      });
      continue;
    }
    const pendentes = etapas.reduce(
      (soma, e) => soma + (e.metricas.totalPendentes ?? 0),
      0,
    );
    if (pendentes > 0) {
      avaliacao.basesComPendencia.push({ base, pendentes });
      continue;
    }
    const concluida = etapas.every(
      (e) =>
        e.status === 'CONCLUIDA' ||
        (e.status === 'PULADA' && e.motivoDoPulo === 'JA_CONCLUIDA'),
    );
    if (concluida) avaliacao.basesConcluidas.push(base);
  }

  avaliacao.incompleta =
    avaliacao.basesEmFalha.length > 0 || avaliacao.basesComPendencia.length > 0;
  return avaliacao;
}

/** Nenhuma base rodou porque todas estavam com execução em curso. */
export function todasEmCurso(resultados: ResultadoMomento[]): boolean {
  return (
    resultados.length > 0 &&
    resultados.every(
      (r) => r.status === 'PULADA' && r.motivoDoPulo === 'EXECUCAO_EM_CURSO',
    )
  );
}

/**
 * A régua terminou com base em falha ou com envios pendentes. É erro
 * TRANSITÓRIO (um `Error` comum): o retry da fila repete a rotina, e a
 * idempotência por log impede reenvio para quem já recebeu.
 */
export class ReguaIncompletaError extends Error {
  constructor(readonly avaliacao: AvaliacaoDaRegua) {
    const partes: string[] = [];
    if (avaliacao.basesEmFalha.length > 0) {
      partes.push(
        `bases em falha: ${avaliacao.basesEmFalha
          .map((b) => `${b.base} (${b.erro})`)
          .join('; ')}`,
      );
    }
    if (avaliacao.basesComPendencia.length > 0) {
      partes.push(
        `bases com envios pendentes: ${avaliacao.basesComPendencia
          .map((b) => `${b.base} (${b.pendentes})`)
          .join('; ')}`,
      );
    }
    super(
      `Régua de boletos incompleta em ${avaliacao.dataReferencia ?? '?'} — ${partes.join(' | ')}`.slice(
        0,
        2000,
      ),
    );
    this.name = 'ReguaIncompletaError';
  }
}

/**
 * Progresso que o job guarda entre tentativas: as bases que ele já fechou
 * para uma data. A data vai junto para o progresso nunca valer em outro dia.
 */
export interface ProgressoDoJob {
  /** dd/mm/yyyy */
  dataReferencia: string;
  basesConcluidas: string[];
}

/** Bases já concluídas por este job PARA esta data; vazio se for outra. */
export function basesJaConcluidas(
  progresso: ProgressoDoJob | null | undefined,
  dataReferencia: string,
): string[] {
  if (!progresso || progresso.dataReferencia !== dataReferencia) return [];
  return Array.isArray(progresso.basesConcluidas)
    ? progresso.basesConcluidas.filter((b) => typeof b === 'string')
    : [];
}

/** Progresso a gravar depois de uma tentativa incompleta. */
export function progressoAposTentativa(
  avaliacao: AvaliacaoDaRegua,
  anteriores: string[],
): ProgressoDoJob | null {
  if (!avaliacao.dataReferencia) return null;
  return {
    dataReferencia: avaliacao.dataReferencia,
    basesConcluidas: Array.from(
      new Set([...anteriores, ...avaliacao.basesConcluidas]),
    ),
  };
}
