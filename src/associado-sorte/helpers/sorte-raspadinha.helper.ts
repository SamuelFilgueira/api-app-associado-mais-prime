import {
  diaSaoPaulo,
  inicioDoDiaSaoPaulo,
  proximaViradaDoDia,
} from 'src/associado-sorte/helpers/sorte-data.helper';

/**
 * Regras puras da raspadinha (limite diário, intervalo e lembrete), sem
 * Nest/Prisma. A janela é o dia do calendário em America/Sao_Paulo: raspada
 * não usada não acumula, e a primeira raspada do dia é liberada à 00:00
 * (o intervalo mínimo só vale entre raspadas do mesmo dia).
 */

export type SorteBloqueioRaspada = 'LIMITE_DIARIO' | 'INTERVALO';

export interface JanelaRaspada {
  raspadasHoje: number;
  raspadasRestantesHoje: number;
  /**
   * Quando a próxima raspada fica liberada. Já liberada → instante em que
   * liberou (≤ agora). Sem raspadas no dia → próxima virada do dia.
   */
  proximaRaspadaEm: Date;
  bloqueio: SorteBloqueioRaspada | null;
}

export function calcularJanelaRaspada(params: {
  agora: Date;
  raspadasHoje: number;
  /** Última raspada do dia de hoje (São Paulo), ou `null`. */
  ultimaRaspadaHojeEm: Date | null;
  raspadasPorDia: number;
  intervaloMinimoMinutos: number;
}): JanelaRaspada {
  const { agora, raspadasHoje, ultimaRaspadaHojeEm } = params;
  const porDia = Math.max(1, params.raspadasPorDia);
  const restantes = Math.max(0, porDia - raspadasHoje);

  if (restantes === 0) {
    return {
      raspadasHoje,
      raspadasRestantesHoje: 0,
      proximaRaspadaEm: proximaViradaDoDia(agora),
      bloqueio: 'LIMITE_DIARIO',
    };
  }

  const liberacao = liberacaoDaRaspada({
    agora,
    raspadasHoje,
    ultimaRaspadaHojeEm,
    intervaloMinimoMinutos: params.intervaloMinimoMinutos,
  });
  // Intervalo que ultrapassa a meia-noite: o dia seguinte libera à 00:00.
  const virada = proximaViradaDoDia(agora);
  const proximaRaspadaEm =
    liberacao.getTime() > virada.getTime() ? virada : liberacao;

  return {
    raspadasHoje,
    raspadasRestantesHoje: restantes,
    proximaRaspadaEm,
    bloqueio: proximaRaspadaEm.getTime() > agora.getTime() ? 'INTERVALO' : null,
  };
}

/**
 * Instante em que a próxima raspada do dia libera: 00:00 do dia (sem raspada
 * hoje) ou a última raspada + intervalo mínimo.
 */
export function liberacaoDaRaspada(params: {
  agora: Date;
  raspadasHoje: number;
  ultimaRaspadaHojeEm: Date | null;
  intervaloMinimoMinutos: number;
}): Date {
  const inicioDoDia = inicioDoDiaSaoPaulo(diaSaoPaulo(params.agora));
  if (params.raspadasHoje === 0 || !params.ultimaRaspadaHojeEm) {
    return inicioDoDia;
  }
  return new Date(
    params.ultimaRaspadaHojeEm.getTime() +
      Math.max(0, params.intervaloMinimoMinutos) * 60_000,
  );
}

// ---------------------------------------------------------------- lembrete

const FORMATADOR_HORA = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Minutos desde 00:00 em São Paulo. */
export function minutosDoDiaSaoPaulo(agora: Date): number {
  const [h, m] = FORMATADOR_HORA.format(agora).split(':').map(Number);
  return (h % 24) * 60 + m;
}

/** "HH:MM" → minutos, ou `null` se inválido. */
export function lerHoraMinuto(valor: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(valor ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * `agora` está dentro da janela de envio [inicio, fim) em São Paulo? Aceita
 * janela que passa da meia-noite (inicio > fim). Janela vazia (inicio = fim)
 * nunca envia.
 */
export function dentroDaJanelaDeLembrete(
  agora: Date,
  inicio: string,
  fim: string,
): boolean {
  const ini = lerHoraMinuto(inicio);
  const f = lerHoraMinuto(fim);
  if (ini === null || f === null || ini === f) return false;
  const atual = minutosDoDiaSaoPaulo(agora);
  return ini < f ? atual >= ini && atual < f : atual >= ini || atual < f;
}

/**
 * Deve avisar este associado agora? Tem raspada no dia, a liberação já
 * passou e essa liberação ainda não foi avisada. A janela de envio é
 * conferida à parte (fora dela, ninguém é avisado; a mesma liberação é
 * avisada uma vez quando a janela abrir).
 */
export function deveLembrarRaspada(params: {
  agora: Date;
  raspadasHoje: number;
  ultimaRaspadaHojeEm: Date | null;
  raspadasPorDia: number;
  intervaloMinimoMinutos: number;
  lembreteRaspadaEm: Date | null;
}): { lembrar: boolean; liberacao: Date } {
  const janela = calcularJanelaRaspada(params);
  const liberacao = janela.proximaRaspadaEm;
  const lembrar =
    janela.bloqueio === null &&
    (!params.lembreteRaspadaEm ||
      params.lembreteRaspadaEm.getTime() < liberacao.getTime());
  return { lembrar, liberacao };
}
