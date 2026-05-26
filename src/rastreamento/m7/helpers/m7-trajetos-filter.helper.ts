import { M7TrajetoRaw } from '../interfaces/m7-historico.interface';

function parseDistancia(value: number | string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseVelocidade(value: number | string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isZeroTempo(tempo: string | undefined): boolean {
  if (!tempo) return true;
  return /^0{1,2}:0{1,2}:0{1,2}$/.test(tempo.trim());
}

export function filtrarTrajetos(trajetos: M7TrajetoRaw[]): {
  tipo: string;
  dataInicio: string;
  dataFim: string;
  tempoMovimento: string;
  tempoParado: string;
  tempoTotal: string;
  distanciaMetros: number;
  velocidadeMaxima: number;
  destino: string;
}[] {
  return trajetos
    .filter((t) => {
      if (isZeroTempo(t.tempo_total)) return false;
      if (parseDistancia(t.distancia) === 0 && parseVelocidade(t.velocidade_maxima) === 0)
        return false;
      return true;
    })
    .map((t) => ({
      tipo: String(t.tipo ?? ''),
      dataInicio: String(t.data_inicio ?? ''),
      dataFim: String(t.data_fim ?? ''),
      tempoMovimento: String(t.tempo_movimento ?? '00:00:00'),
      tempoParado: String(t.tempo_parado ?? '00:00:00'),
      tempoTotal: String(t.tempo_total ?? '00:00:00'),
      distanciaMetros: parseDistancia(t.distancia),
      velocidadeMaxima: parseVelocidade(t.velocidade_maxima),
      destino: String(t.destino ?? ''),
    }));
}
