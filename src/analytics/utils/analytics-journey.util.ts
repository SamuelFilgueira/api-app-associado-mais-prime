import {
  ALLOWED_ACTIONS,
  ALLOWED_FORMS,
  ALLOWED_SCREENS,
} from 'src/analytics/constants/analytics-allowlists';
import {
  DEVICE_TYPES,
  JOURNEY_FORM_OUTCOMES,
  JOURNEY_TIME_TOLERANCE_MS,
  MAX_JOURNEY_EVENTS,
} from 'src/analytics/constants/analytics-journey.constants';
import {
  AnalyticsDeviceInfoDto,
  AnalyticsJourneyEventDto,
} from 'src/analytics/dto/create-analytics-summary.dto';
import { CLAMP, clampInt } from 'src/analytics/utils/analytics-sanitizer.util';

/** Dados do aparelho já sanitizados (prontos para persistir). */
export interface SanitizedDeviceInfo {
  brand: string | null;
  model: string | null;
  model_id: string | null;
  os_name: string | null;
  os_version: string | null;
  device_type: string | null;
  timezone: string | null;
}

/** Evento de jornada já sanitizado e validado contra as allowlists. */
export interface SanitizedJourneyEvent {
  /** ISO 8601 (UTC). */
  t: string;
  type: 'screen' | 'action' | 'form';
  event: string;
  duration_ms: number | null;
  screen: string | null;
  outcome: string | null;
}

function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  // Remove caracteres de controle e colapsa espaços; strings vazias viram null.
  const cleaned = value
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Sanitiza o bloco `device`. Retorna null quando nada útil foi informado,
 * para que o aparelho seja registrado só com plataforma/versão.
 */
export function sanitizeDeviceInfo(
  device: AnalyticsDeviceInfoDto | undefined,
): SanitizedDeviceInfo | null {
  if (!device || typeof device !== 'object') return null;

  const deviceType = cleanText(device.device_type, 20)?.toLowerCase() ?? null;

  const result: SanitizedDeviceInfo = {
    brand: cleanText(device.brand, 40),
    model: cleanText(device.model, 80),
    model_id: cleanText(device.model_id, 40),
    os_name: cleanText(device.os_name, 20),
    os_version: cleanText(device.os_version, 20),
    device_type: deviceType && DEVICE_TYPES.has(deviceType) ? deviceType : null,
    timezone: cleanText(device.timezone, 60),
  };

  const hasAnyValue = Object.values(result).some((v) => v !== null);
  return hasAnyValue ? result : null;
}

/**
 * Sanitiza a lista `journey`:
 *  - descarta eventos fora da allowlist do seu tipo;
 *  - descarta horários inválidos ou fora da janela do summary (± tolerância);
 *  - limita a MAX_JOURNEY_EVENTS eventos;
 *  - ordena por horário (estável) para que `seq` reflita a sequência real.
 *
 * Retorna os eventos aceitos e a quantidade descartada (vai para o recibo).
 */
export function sanitizeJourney(
  journey: AnalyticsJourneyEventDto[] | undefined,
  periodStart: Date,
  periodEnd: Date,
): { accepted: SanitizedJourneyEvent[]; discarded: number } {
  if (!Array.isArray(journey) || journey.length === 0) {
    return { accepted: [], discarded: 0 };
  }

  const minTs = periodStart.getTime() - JOURNEY_TIME_TOLERANCE_MS;
  const maxTs = periodEnd.getTime() + JOURNEY_TIME_TOLERANCE_MS;

  const accepted: Array<SanitizedJourneyEvent & { ts: number; idx: number }> =
    [];
  let discarded = 0;

  journey.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      discarded++;
      return;
    }

    const ts = new Date(raw.t).getTime();
    if (!Number.isFinite(ts) || ts < minTs || ts > maxTs) {
      discarded++;
      return;
    }

    const event = cleanText(raw.event, 80);
    if (!event) {
      discarded++;
      return;
    }

    let allowed = false;
    let durationMs: number | null = null;
    let screen: string | null = null;
    let outcome: string | null = null;

    switch (raw.type) {
      case 'screen':
        allowed = ALLOWED_SCREENS.has(event);
        durationMs =
          raw.duration_ms === undefined || raw.duration_ms === null
            ? null
            : clampInt(
                raw.duration_ms,
                CLAMP.TOTAL_TIME_MS.min,
                CLAMP.TOTAL_TIME_MS.max,
              );
        break;
      case 'action':
        allowed = ALLOWED_ACTIONS.has(event);
        break;
      case 'form': {
        allowed = ALLOWED_FORMS.has(event);
        const rawScreen = cleanText(raw.screen, 80);
        screen = rawScreen && ALLOWED_SCREENS.has(rawScreen) ? rawScreen : null;
        outcome =
          typeof raw.outcome === 'string' &&
          (JOURNEY_FORM_OUTCOMES as readonly string[]).includes(raw.outcome)
            ? raw.outcome
            : null;
        break;
      }
      default:
        allowed = false;
    }

    if (!allowed) {
      discarded++;
      return;
    }

    accepted.push({
      t: new Date(ts).toISOString(),
      type: raw.type,
      event,
      duration_ms: durationMs,
      screen,
      outcome,
      ts,
      idx,
    });
  });

  // Ordenação estável por horário; empate mantém a ordem enviada pelo app.
  accepted.sort((a, b) => a.ts - b.ts || a.idx - b.idx);

  if (accepted.length > MAX_JOURNEY_EVENTS) {
    discarded += accepted.length - MAX_JOURNEY_EVENTS;
    accepted.length = MAX_JOURNEY_EVENTS;
  }

  return {
    accepted: accepted.map(({ ts: _ts, idx: _idx, ...event }) => event),
    discarded,
  };
}
