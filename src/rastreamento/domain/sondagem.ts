/**
 * Regra pura de QUAIS provedores consultar numa rodada de posição.
 *
 * O veículo guarda o provedor que respondeu por último. Enquanto ele estiver
 * saudável, só ele é chamado; os demais só entram quando ele falha, quando
 * acumula falhas demais ou quando passa da hora de conferir de novo.
 */

/** O que o veículo lembra do provedor (colunas de `UserVehicle`). */
export interface MemoriaDeProvedor {
  provedor: string | null;
  falhas: number;
  /** Instante (ms) da última rodada completa que confirmou o provedor. */
  verificadoEm: number | null;
}

export type PlanoDeSondagem =
  /** Chama só o provedor conhecido; `demais` ficam de reserva. */
  | { tipo: 'conhecido'; provedor: string; demais: string[] }
  /** Consulta todos em paralelo. */
  | { tipo: 'todos'; provedores: string[] };

export interface JanelasDeRevalidacao {
  /** Posição mais velha que isto é tratada como "veículo parado". */
  posicaoParadaMs: number;
  /** Com posição recente, confere os demais provedores a cada tanto. */
  emMovimentoMs: number;
  /** Com posição velha, confere mais vezes: o rastreador pode ter morrido. */
  paradoMs: number;
}

/**
 * Monta o plano da rodada. `configurados` vem na ordem do registro de
 * provedores e só traz os que têm credencial para a base.
 */
export function planejarSondagem(
  memoria: MemoriaDeProvedor | null,
  configurados: readonly string[],
  limiteDeFalhas: number,
): PlanoDeSondagem {
  const conhecido = memoria?.provedor ?? null;
  if (
    !conhecido ||
    !configurados.includes(conhecido) ||
    memoria!.falhas >= limiteDeFalhas
  ) {
    return { tipo: 'todos', provedores: [...configurados] };
  }
  return {
    tipo: 'conhecido',
    provedor: conhecido,
    demais: configurados.filter((nome) => nome !== conhecido),
  };
}

/**
 * O provedor conhecido respondeu: ainda assim vale conferir os demais?
 *
 * Sim quando a última conferência completa está velha. A régua é curta se a
 * posição recebida está parada no tempo — um rastreador desligado continua
 * "respondendo" com a posição antiga, e é justamente aí que outro provedor
 * pode ter a posição viva.
 */
export function precisaRevalidar(
  entrada: {
    agora: number;
    verificadoEm: number | null;
    timestampDaPosicao: number;
  },
  janelas: JanelasDeRevalidacao,
): boolean {
  if (entrada.verificadoEm === null) return true;
  const idadeDaPosicao = entrada.agora - entrada.timestampDaPosicao;
  const janela =
    idadeDaPosicao > janelas.posicaoParadaMs
      ? janelas.paradoMs
      : janelas.emMovimentoMs;
  return entrada.agora - entrada.verificadoEm > janela;
}
