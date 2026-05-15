import { Logger } from '@nestjs/common';
import axios from 'axios';
import { TrajetoriaSoftruckRota } from '../dto/trajetorias.dto';

const logger = new Logger('GeoUtils');

/** Limite de chamadas ao Nominatim por geração de PDF */
const MAX_GEOCODING = 40;

/** Intervalo de segurança entre chamadas ao Nominatim (ms) */
const GEOCODING_DELAY_MS = 1100;

/** Cache de endereços por coordenada normalizada. Singleton de módulo para persistir entre chamadas. */
const geocodeCache = new Map<string, string>();

/** Aguarda um tempo em ms. */
async function aguardar(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza coordenada para reduzir cardinalidade de pontos próximos.
 * Ex.: -22.973696,-43.370782 -> "-22.97,-43.37"
 */
export function normalizarCoord(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

/**
 * Resolve endereço por coordenada via Nominatim.
 * Usa cache, não faz retry em 429 (fallback imediato).
 */
export async function getEnderecoPorCoordenada(
  lat: number,
  lng: number,
): Promise<string | null> {
  const chave = normalizarCoord(lat, lng);
  const cached = geocodeCache.get(chave);
  if (cached) return cached;

  try {
    const response = await axios.get(
      'https://nominatim.openstreetmap.org/reverse',
      {
        params: { lat, lon: lng, format: 'jsonv2' },
        headers: { 'User-Agent': 'beneficios-api/1.0' },
        timeout: 5_000,
      },
    );

    const address = response.data?.address;
    if (!address) return null;

    const endereco = [
      address.road,
      address.suburb,
      address.city || address.town,
      address.state,
    ]
      .filter(Boolean)
      .join(', ');

    geocodeCache.set(chave, endereco);
    return endereco;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      logger.warn(`Geocoding 429 para ${chave} — fallback imediato`);
      return null;
    }
    logger.warn(
      `Geocoding falhou para ${chave}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Geocodifica todas as coordenadas únicas de uma lista de rotas.
 * Respeita limite MAX_GEOCODING e delay entre chamadas.
 * Retorna mapa coordenada-normalizada → endereço.
 */
export async function geocodificarCoordenadas(
  rotas: TrajetoriaSoftruckRota[],
): Promise<Map<string, string>> {
  const resultado = new Map<string, string>();

  const coordenadasUnicas = new Set<string>();
  for (const rota of rotas) {
    coordenadasUnicas.add(
      normalizarCoord(rota.startPosition.latitude, rota.startPosition.longitude),
    );
    coordenadasUnicas.add(
      normalizarCoord(rota.endPosition.latitude, rota.endPosition.longitude),
    );
  }

  let geocodingExecutados = 0;

  for (const chave of coordenadasUnicas) {
    const cached = geocodeCache.get(chave);
    if (cached) {
      resultado.set(chave, cached);
      continue;
    }

    if (geocodingExecutados >= MAX_GEOCODING) {
      continue;
    }

    const [latStr, lngStr] = chave.split(',');
    const endereco = await getEnderecoPorCoordenada(
      Number(latStr),
      Number(lngStr),
    );
    if (endereco) resultado.set(chave, endereco);
    geocodingExecutados += 1;

    await aguardar(GEOCODING_DELAY_MS);
  }

  logger.log(
    `[Trajetorias PDF] geocodingExecutados=${geocodingExecutados} totalUnicas=${coordenadasUnicas.size}`,
  );

  return resultado;
}
