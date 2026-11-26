/**
 * Regras da verificação de economia pós-abastecimento (funções puras).
 *
 * Fluxo: o associado abre o cartão virtual → nasce uma sessão `PENDING` com
 * o total economizado lido do Clubgas naquele instante (`valorAntes`) → o
 * worker consulta o total de novo algumas vezes → se subiu, a diferença é a
 * economia do abastecimento; se não subiu até o teto de checagens, a sessão
 * expira.
 *
 * "Sem variação ainda" NÃO é erro: o job conclui e agenda a próxima checagem.
 * Antes isso era um `throw` para forçar o retry do BullMQ — toda consulta ao
 * cartão sem abastecimento terminava como job falho (e, com a fila de
 * mortos, como alerta).
 */

/** Nome do job na `FUEL_ECONOMY_QUEUE`. */
export const JOB_CHECAR_ECONOMIA = 'check-fuel-economy';

/** A primeira checagem roda 5 minutos depois de o cartão ser aberto. */
export const ATRASO_DA_PRIMEIRA_CHECAGEM_MS = 5 * 60_000;

/**
 * Intervalo entre as checagens seguintes: 60 s, 120 s... — os mesmos tempos
 * do backoff exponencial de 60 s que o retry do job produzia.
 */
export const INTERVALO_BASE_ENTRE_CHECAGENS_MS = 60_000;

/**
 * Total de checagens por sessão (aos 5, 6 e 8 minutos): as mesmas 3
 * tentativas que o job tinha quando "sem variação" era retry.
 */
export const TETO_DE_CHECAGENS = 3;

/**
 * Sessão `PENDING` mais velha que isto ficou órfã (o job que a encerraria
 * não rodou ou não conseguiu expirá-la) e vence na próxima abertura do
 * cartão. O ciclo normal dura 8 minutos; com os retries de erro real, menos
 * de 20.
 */
export const VALIDADE_DA_SESSAO_PENDENTE_MS = 30 * 60_000;

/** Payload do job de checagem. */
export interface DadosDaChecagem {
  fuelSessionId: string;
  /**
   * Número desta checagem (1, 2, 3). Ausente nos jobs criados antes do
   * contador existir — ver `numeroDaChecagem`.
   */
  checagem?: number;
}

/**
 * Qual checagem este job representa.
 *
 * Job novo traz o contador no payload. Job antigo (sem contador) repetia a
 * checagem pelo retry do BullMQ, então as tentativas que ele já gastou são
 * as checagens que já fez.
 */
export function numeroDaChecagem(
  dados: Pick<DadosDaChecagem, 'checagem'>,
  tentativasJaFeitas: number,
): number {
  const informada = dados.checagem;
  if (
    typeof informada === 'number' &&
    Number.isInteger(informada) &&
    informada >= 1
  ) {
    return informada;
  }
  const gastas = Number.isInteger(tentativasJaFeitas) ? tentativasJaFeitas : 0;
  return Math.max(0, gastas) + 1;
}

/** Quanto esperar, depois da checagem informada, até a próxima. */
export function atrasoAteAProximaChecagem(checagem: number): number {
  return INTERVALO_BASE_ENTRE_CHECAGENS_MS * 2 ** (Math.max(1, checagem) - 1);
}

/**
 * Id determinístico do job de uma checagem: reenfileirar a mesma checagem da
 * mesma sessão (retry do job que a agendou) não cria um segundo job.
 */
export function jobIdDaChecagem(sessionId: string, checagem: number): string {
  return `fuel-${sessionId}-c${checagem}`;
}

/**
 * Valor de `FuelSession.pendenteChave` enquanto a sessão está `PENDING`. O
 * índice único sobre a coluna garante uma sessão pendente por usuário.
 */
export function chaveDePendencia(userId: number): string {
  return String(userId);
}

/** Instante antes do qual uma sessão `PENDING` é considerada órfã. */
export function corteDeSessaoPendente(agora: Date): Date {
  return new Date(agora.getTime() - VALIDADE_DA_SESSAO_PENDENTE_MS);
}

export type DecisaoDaChecagem =
  /** O total subiu: houve abastecimento. */
  | { tipo: 'ABASTECEU'; diferenca: number; novoTotal: number }
  /** Ainda sem variação e há checagens restantes. */
  | { tipo: 'REAGENDAR'; proximaChecagem: number; atrasoMs: number }
  /** Sem variação na última checagem: a sessão expira. */
  | { tipo: 'EXPIRAR' };

/** O que fazer com a sessão depois de ler o total atual no Clubgas. */
export function decidirChecagem(entrada: {
  valorAntes: number;
  valorAtual: number;
  checagem: number;
}): DecisaoDaChecagem {
  const { valorAntes, valorAtual, checagem } = entrada;

  if (valorAtual > valorAntes) {
    return {
      tipo: 'ABASTECEU',
      diferenca: valorAtual - valorAntes,
      novoTotal: valorAtual,
    };
  }
  if (checagem >= TETO_DE_CHECAGENS) return { tipo: 'EXPIRAR' };
  return {
    tipo: 'REAGENDAR',
    proximaChecagem: checagem + 1,
    atrasoMs: atrasoAteAProximaChecagem(checagem),
  };
}

/** Texto do push de economia. */
export function mensagemDeEconomia(diferenca: number): {
  titulo: string;
  corpo: string;
} {
  return {
    titulo: 'Abastecimento detectado! 🎉',
    corpo: `Parabéns! Você economizou R$ ${diferenca.toFixed(2).replace('.', ',')} neste abastecimento.`,
  };
}
