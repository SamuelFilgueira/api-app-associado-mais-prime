import { formatDateISO, startOfDay } from 'src/shared/date.util';
import {
  DirectPartnerCouponStatus,
  DirectPartnerOpeningHour,
} from 'src/direct-partners/enums/direct-partner.enums';

/**
 * Funções puras de regra de negócio dos parceiros diretos (§4 da spec).
 * Sem dependência de Nest/Prisma para facilitar teste unitário.
 *
 * O processo roda com TZ=America/Sao_Paulo (src/main.ts), então os métodos
 * locais de Date já refletem o fuso da operação.
 */

/** Palavras ignoradas no cálculo das iniciais do tile. */
const STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'a',
  'o',
  'as',
  'os',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'com',
  'para',
  'por',
  'um',
  'uma',
  '&',
]);

/**
 * Iniciais do tile quando não há logo: primeira letra das duas primeiras
 * palavras relevantes ("Auto Center Premium" → "AC"). Nome com uma única
 * palavra devolve as duas primeiras letras ("Padaria" → "PA").
 */
export function calcularIniciais(nome: string): string {
  const palavras = (nome ?? '')
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((p) => p.length > 0);

  const relevantes = palavras.filter((p) => !STOPWORDS.has(p.toLowerCase()));
  const fonte = relevantes.length > 0 ? relevantes : palavras;

  if (fonte.length === 0) return '';
  if (fonte.length === 1) return fonte[0].slice(0, 2).toUpperCase();
  return (fonte[0][0] + fonte[1][0]).toUpperCase();
}

/** Distância em km entre dois pontos (fórmula de haversine), 1 casa decimal. */
export function distanciaKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function minutosDoDia(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Indica se o estabelecimento está aberto em `agora` segundo a grade.
 * `null` quando não há horário estruturado. Horário que atravessa a
 * meia-noite (`closes < opens`) é válido e considera o dia anterior.
 */
export function calcularAbertoAgora(
  horarios: DirectPartnerOpeningHour[] | null | undefined,
  agora: Date = new Date(),
): boolean | null {
  if (!Array.isArray(horarios) || horarios.length === 0) return null;

  const diaHoje = agora.getDay();
  const diaOntem = (diaHoje + 6) % 7;
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();

  for (const h of horarios) {
    const abre = minutosDoDia(h.opens);
    const fecha = minutosDoDia(h.closes);
    const atravessaMeiaNoite = fecha < abre;

    if (h.weekday === diaHoje) {
      if (!atravessaMeiaNoite) {
        if (minutosAgora >= abre && minutosAgora < fecha) return true;
      } else if (minutosAgora >= abre) {
        return true;
      }
    }

    // Madrugada: turno iniciado ontem que ainda não fechou
    if (h.weekday === diaOntem && atravessaMeiaNoite && minutosAgora < fecha) {
      return true;
    }
  }

  return false;
}

/**
 * Valida a grade de horários: formato HH:mm, dia sem duplicidade e
 * `opens !== closes`. Retorna a mensagem do erro ou `null` se válida.
 */
export function validarHorarios(
  horarios: DirectPartnerOpeningHour[] | null | undefined,
): string | null {
  if (!horarios) return null;
  const regex = /^([01]\d|2[0-3]):[0-5]\d$/;
  const dias = new Set<number>();

  for (const h of horarios) {
    if (!Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6) {
      return `dia da semana inválido: ${String(h.weekday)}`;
    }
    if (!regex.test(h.opens) || !regex.test(h.closes)) {
      return `horário inválido no dia ${h.weekday} (esperado HH:mm)`;
    }
    if (h.opens === h.closes) {
      return `abertura e fechamento iguais no dia ${h.weekday}`;
    }
    if (dias.has(h.weekday)) {
      return `dia da semana duplicado: ${h.weekday}`;
    }
    dias.add(h.weekday);
  }

  return null;
}

/**
 * Converte "yyyy-mm-dd" (ou ISO completo) em Date local. Data só com dia
 * vira meia-noite local para que a comparação "fim do dia inclusivo" use
 * `startOfDay(agora) <= validUntil`.
 */
export function parseDataCupom(value: string | null | undefined): Date | null {
  if (!value) return null;
  const soDia = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (soDia) {
    return new Date(Number(soDia[1]), Number(soDia[2]) - 1, Number(soDia[3]));
  }
  const data = new Date(value);
  return Number.isNaN(data.getTime()) ? null : data;
}

/** Serializa a data do cupom como "yyyy-mm-dd" (o app formata para pt-BR). */
export function formatarDataCupom(
  value: Date | null | undefined,
): string | null {
  if (!value) return null;
  return formatDateISO(value);
}

/** Limite inferior de `validUntil` para o cupom ainda valer hoje. */
export function inicioDoDia(agora: Date = new Date()): Date {
  return startOfDay(agora);
}

export interface CupomVisibilidade {
  isActive: boolean;
  validFrom: Date | null;
  validUntil: Date;
}

/** Regra §4.3: ativo, dentro do período (fim do dia inclusivo). */
export function cupomVisivel(
  cupom: CupomVisibilidade,
  agora: Date = new Date(),
): boolean {
  return statusCupom(cupom, agora) === DirectPartnerCouponStatus.VISIVEL;
}

/** Status derivado do cupom exibido no painel (§5.7). */
export function statusCupom(
  cupom: CupomVisibilidade,
  agora: Date = new Date(),
): DirectPartnerCouponStatus {
  if (!cupom.isActive) return DirectPartnerCouponStatus.INATIVO;
  if (cupom.validUntil < startOfDay(agora)) {
    return DirectPartnerCouponStatus.VENCIDO;
  }
  if (cupom.validFrom && cupom.validFrom > agora) {
    return DirectPartnerCouponStatus.AGENDADO;
  }
  return DirectPartnerCouponStatus.VISIVEL;
}

/**
 * Monta o logradouro exibido no app: `street` + (`, number`) + (` – complement`).
 * Sem número não sobra vírgula ("Av. X – Quiosque 3").
 */
export function montarLogradouro(endereco: {
  street: string;
  number?: string | null;
  complement?: string | null;
}): string {
  let texto = endereco.street.trim();
  const numero = endereco.number?.trim();
  const complemento = endereco.complement?.trim();
  if (numero) texto += `, ${numero}`;
  if (complemento) texto += ` – ${complemento}`;
  return texto;
}

/**
 * Deriva `melhorBeneficio` / `textoDesconto` dos cupons visíveis: maior
 * percentual encontrado nos `highlight`; sem percentual, usa o highlight
 * do primeiro cupom (já ordenado por `sortOrder`).
 */
export function derivarMelhorBeneficio(highlights: string[]): {
  melhorBeneficio: string | null;
  textoDesconto: string | null;
} {
  if (highlights.length === 0) {
    return { melhorBeneficio: null, textoDesconto: null };
  }

  let maiorPercentual: number | null = null;
  for (const h of highlights) {
    const match = h.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (match) {
      const valor = Number(match[1].replace(',', '.'));
      if (maiorPercentual === null || valor > maiorPercentual) {
        maiorPercentual = valor;
      }
    }
  }

  if (maiorPercentual !== null) {
    const texto = `${String(maiorPercentual).replace('.', ',')}%`;
    return {
      melhorBeneficio: `até ${texto}`,
      textoDesconto: `Até ${texto} de desconto`,
    };
  }

  return { melhorBeneficio: highlights[0], textoDesconto: highlights[0] };
}

/** CPF mascarado para o painel: "***.456.789-**". */
export function mascararCpfPainel(cpf: string | null | undefined): string {
  const digitos = (cpf ?? '').replace(/\D/g, '');
  if (digitos.length !== 11) return '***.***.***-**';
  return `***.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-**`;
}

/** Normaliza o código do cupom: caixa alta, sem espaços. */
export function normalizarCodigoCupom(code: string): string {
  return String(code ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** Lê o JSON `alloyalCategoryIds` com tolerância a valor nulo/inválido. */
export function lerAlloyalCategoryIds(json: unknown): Record<string, number[]> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const resultado: Record<string, number[]> = {};
  for (const [base, ids] of Object.entries(json as Record<string, unknown>)) {
    if (Array.isArray(ids)) {
      resultado[base] = ids
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v));
    }
  }
  return resultado;
}

/** Lê o JSON `openingHours` com tolerância a valor nulo/inválido. */
export function lerHorarios(json: unknown): DirectPartnerOpeningHour[] | null {
  if (!Array.isArray(json)) return null;
  const horarios = json.filter(
    (h): h is DirectPartnerOpeningHour =>
      !!h &&
      typeof h === 'object' &&
      typeof (h as DirectPartnerOpeningHour).opens === 'string' &&
      typeof (h as DirectPartnerOpeningHour).closes === 'string',
  );
  return horarios.length > 0 ? horarios : null;
}

/** Lê o JSON `conditions` como lista de strings. */
export function lerCondicoes(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((c): c is string => typeof c === 'string');
}
