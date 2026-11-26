import { M7PontoHistoricoRaw } from '../interfaces/m7-historico.interface';
import { HistoricoM7RotasPontoDto } from '../dto/historico-m7-response.dto';
import { percorrerEmBlocos } from 'src/rastreamento/helpers/ceder-event-loop';

/** Distância mínima entre pontos consecutivos (metros) */
const MIN_DISTANCIA_METROS = 15;

/** Intervalo mínimo entre pontos consecutivos (segundos) */
const MIN_INTERVALO_SEGUNDOS = 5;

export function calcularDistanciaMetros(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseIgnicao(value: boolean | number | string | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'ligado';
  }
  return false;
}

function parseDataGpsMs(valor: unknown): number | null {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  const iso = valor.includes('T') ? valor : valor.replace(' ', 'T');
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Amostragem temporal para o relatório de contestação V2: mantém um ponto
 * apenas se ele estiver a pelo menos `intervaloSeg` do último ponto mantido.
 *
 * Regras:
 * - o primeiro e o último ponto são sempre mantidos;
 * - pontos sem `data_gps` parseável são mantidos (não há como medir o intervalo);
 * - `intervaloSeg <= 0` devolve a lista original (amostragem desligada);
 * - a ordem original é preservada.
 */
export function amostrarPontosPorIntervalo(
  pontos: M7PontoHistoricoRaw[],
  intervaloSeg: number,
): M7PontoHistoricoRaw[] {
  if (!Number.isFinite(intervaloSeg) || intervaloSeg <= 0) return pontos;
  if (pontos.length <= 2) return pontos;

  const intervaloMs = intervaloSeg * 1000;
  const resultado: M7PontoHistoricoRaw[] = [];
  let ultimoMantidoMs: number | null = null;
  const ultimoIndice = pontos.length - 1;

  for (let i = 0; i < pontos.length; i++) {
    const ponto = pontos[i];
    const ms = parseDataGpsMs(ponto.data_gps);

    if (ms === null || i === 0 || i === ultimoIndice) {
      resultado.push(ponto);
      if (ms !== null) ultimoMantidoMs = ms;
      continue;
    }

    if (ultimoMantidoMs === null || ms - ultimoMantidoMs >= intervaloMs) {
      resultado.push(ponto);
      ultimoMantidoMs = ms;
    }
  }

  return resultado;
}

/**
 * Sanitizador ponto a ponto. Guarda o último ponto aceito para descartar
 * jitter (menos de 15 m em menos de 5 s); coordenada inválida ou ponto sem
 * data também saem. `aceitar` devolve o ponto normalizado ou `null`.
 */
export function criarSanitizadorDePontosGps(): {
  aceitar(ponto: M7PontoHistoricoRaw): HistoricoM7RotasPontoDto | null;
} {
  let ultimo: HistoricoM7RotasPontoDto | null = null;

  return {
    aceitar(ponto) {
      const lat = Number(ponto.latitude);
      const lng = Number(ponto.longitude);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat === 0 ||
        lng === 0 ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        return null;
      }

      if (!ponto.data_gps) return null;

      const dataGps = String(ponto.data_gps);
      const velocidade = Number(ponto.velocidade ?? 0);

      if (ultimo) {
        const distancia = calcularDistanciaMetros(
          ultimo.latitude,
          ultimo.longitude,
          lat,
          lng,
        );
        const intervaloMs =
          new Date(dataGps).getTime() - new Date(ultimo.dataGps).getTime();
        const intervaloSeg = intervaloMs / 1000;

        if (
          distancia < MIN_DISTANCIA_METROS &&
          intervaloSeg < MIN_INTERVALO_SEGUNDOS
        ) {
          return null;
        }
      }

      const normalizado: HistoricoM7RotasPontoDto = {
        latitude: lat,
        longitude: lng,
        velocidade: Number.isFinite(velocidade) ? velocidade : 0,
        ignicao: parseIgnicao(ponto.ignicao),
        dataGps,
      };

      ultimo = normalizado;
      return normalizado;
    },
  };
}

export function sanitizarPontosGps(
  pontos: M7PontoHistoricoRaw[],
): HistoricoM7RotasPontoDto[] {
  const sanitizador = criarSanitizadorDePontosGps();
  const resultado: HistoricoM7RotasPontoDto[] = [];

  for (const ponto of pontos) {
    const aceito = sanitizador.aceitar(ponto);
    if (aceito) resultado.push(aceito);
  }

  return resultado;
}

/**
 * Mesmo resultado de `sanitizarPontosGps`, cedendo o event loop a cada bloco
 * de pontos (31 dias de histórico são dezenas de milhares de pontos).
 */
export async function sanitizarPontosGpsEmBlocos(
  pontos: M7PontoHistoricoRaw[],
): Promise<HistoricoM7RotasPontoDto[]> {
  const sanitizador = criarSanitizadorDePontosGps();
  const resultado: HistoricoM7RotasPontoDto[] = [];

  await percorrerEmBlocos(pontos, (ponto) => {
    const aceito = sanitizador.aceitar(ponto);
    if (aceito) resultado.push(aceito);
  });

  return resultado;
}
