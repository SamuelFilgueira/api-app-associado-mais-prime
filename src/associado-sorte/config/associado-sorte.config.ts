/**
 * Configuração técnica do Associado da Sorte (constantes e leitura de env).
 * Regras de promoção (custos, horários, faixas, carência) NÃO ficam aqui:
 * são configuradas pelo painel e gravadas em `SorteConfig` / `SorteRodada`.
 */

import {
  RedisConnectionOptions,
  redisConnectionOptions,
} from 'src/config/redis.config';

/** Nome do job periódico e id do agendador na fila do módulo. */
export const SORTE_CICLO_JOB = 'sorte-ciclo';
export const SORTE_CICLO_SCHEDULER_ID = 'associado-sorte-ciclo';
/** E-mail de cada compra na loja para a equipe (mesma fila, depois do commit). */
export const SORTE_EMAIL_RETIRADA_JOB = 'sorte-email-retirada';

/**
 * Bases que participam da promoção. O código continua multi-base; associado
 * de outra base recebe a promoção como inativa (`ativa: false`), sem erro.
 */
export const SORTE_BASES_CONTEMPLADAS: readonly string[] = ['MAIS_PRIME'];

export function baseContemplada(baseOrigin: string | null | undefined) {
  return !!baseOrigin && SORTE_BASES_CONTEMPLADAS.includes(baseOrigin);
}

export interface SorteLimiteRequisicoes {
  max: number;
  janelaSeg: number;
}

export interface AssociadoSorteConfig {
  /**
   * Job periódico (apuração, encerramentos e lembretes). DESLIGADO por padrão
   * enquanto a promoção não tem aval para produção: só liga com
   * `ASSOCIADO_SORTE_AGENDADOR=true`.
   */
  agendadorAtivo: boolean;
  /** Intervalo do job que apura sorteios, encerra rodadas e dispara lembretes. */
  cicloIntervaloMs: number;
  /** Antecedência do push "Avise-me" em relação à abertura da rodada. */
  lembreteAntecedenciaMin: number;
  /** Estoque igual ou abaixo disso entra no alerta do painel. */
  estoqueBaixo: number;
  /** Transações de resgate simultâneas no processo (protege o pool do Prisma). */
  resgateConcorrenciaMaxima: number;
  transacao: { maxWait: number; timeout: number };
  /** Cancelamento de rodada estorna vários associados na mesma transação. */
  transacaoLonga: { maxWait: number; timeout: number };
  rateLimit: {
    coletar: SorteLimiteRequisicoes;
    participar: SorteLimiteRequisicoes;
    resgatar: SorteLimiteRequisicoes;
    raspar: SorteLimiteRequisicoes;
    comprar: SorteLimiteRequisicoes;
  };
  /** Transações de compra na loja simultâneas no processo. */
  compraConcorrenciaMaxima: number;
  /** Pushes de "raspadinha liberada" por execução do ciclo (o resto fica para o próximo). */
  lembreteRaspadaLote: number;
  /** Depois de uma falha do SGA, não consulta de novo o mesmo associado por este tempo. */
  inscricaoEsperaAposFalhaMs: number;
  /** URL do painel para o link do e-mail de retirada (opcional). */
  painelUrl: string | null;
  /** Lote de leitura da exportação de auditoria. */
  auditoriaLote: number;
  /** Teto de linhas do CSV do cronograma. */
  cronogramaMaxLinhas: number;
  redis: RedisConnectionOptions;
  /** Quantos ganhadores aparecem na lista pública do app. */
  ultimosGanhadoresLimite: number;
  /** Teto de rodadas devolvidas no resumo do app. */
  rodadasResumoLimite: number;
  /** Rodadas encerradas continuam visíveis no app por este período. */
  encerradasRecentesHoras: number;
}

export function associadoSorteConfig(): AssociadoSorteConfig {
  return {
    agendadorAtivo:
      (process.env.ASSOCIADO_SORTE_AGENDADOR ?? '').trim().toLowerCase() ===
      'true',
    cicloIntervaloMs: 5_000,
    lembreteAntecedenciaMin: 5,
    estoqueBaixo: 3,
    resgateConcorrenciaMaxima: 4,
    transacao: { maxWait: 8_000, timeout: 15_000 },
    transacaoLonga: { maxWait: 8_000, timeout: 60_000 },
    rateLimit: {
      coletar: { max: 10, janelaSeg: 60 },
      participar: { max: 20, janelaSeg: 60 },
      resgatar: { max: 20, janelaSeg: 10 },
      raspar: { max: 10, janelaSeg: 60 },
      comprar: { max: 20, janelaSeg: 10 },
    },
    compraConcorrenciaMaxima: 4,
    lembreteRaspadaLote: inteiroPositivo(
      process.env.ASSOCIADO_SORTE_LEMBRETE_LOTE,
      500,
    ),
    inscricaoEsperaAposFalhaMs: 60_000,
    painelUrl:
      (process.env.ASSOCIADO_SORTE_PAINEL_URL ?? '')
        .trim()
        .replace(/\/$/, '') || null,
    auditoriaLote: 5_000,
    cronogramaMaxLinhas: 20_000,
    redis: redisConnectionOptions(),
    ultimosGanhadoresLimite: 10,
    rodadasResumoLimite: 30,
    encerradasRecentesHoras: 24,
  };
}

function inteiroPositivo(valor: string | undefined, padrao: number): number {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : padrao;
}
