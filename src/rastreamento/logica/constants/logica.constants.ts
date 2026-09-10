import { InternalServerErrorException } from '@nestjs/common';

/**
 * Constantes e helpers da integração Lógica Soluções — antes duplicados
 * literalmente em logica-auth.service, rastreamento.logica e trajetos.service.
 */

/** Timeout padrão para chamadas HTTP à API da Lógica (em ms). */
export const LOGICA_REQUEST_TIMEOUT = 15_000;

/** O /mobile/posicao devolve o dia inteiro (~2 MB) — timeout maior. */
export const LOGICA_POSICAO_TIMEOUT = 30_000;

// URLs absolutas usadas pelo relatório de trajetos. Intencionalmente NÃO
// derivadas de LOGICA_API_BASE_URL: apontá-las para a env mudaria o destino
// das chamadas em ambientes cuja env diverge deste host (pendência B11).
export const LOGICA_TRAJETO_URL =
  'https://monitoramento.logicasolucoes.com.br/mobile/trajeto';
export const LOGICA_POSICAO_URL =
  'https://monitoramento.logicasolucoes.com.br/mobile/posicao';

/** Monta URL da API Lógica a partir de LOGICA_API_BASE_URL (lança se ausente). */
export function buildLogicaUrl(path: string): string {
  const baseUrl = process.env.LOGICA_API_BASE_URL;

  if (!baseUrl) {
    throw new InternalServerErrorException(
      'LOGICA_API_BASE_URL não definida nas variáveis de ambiente',
    );
  }

  const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalized}/${path.replace(/^\//, '')}`;
}

/** Detecta resposta da Lógica indicando token inválido/expirado. */
export function isLogicaTokenInvalidResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;

  const value = data as Record<string, unknown>;
  const logado = value.logado;
  const erro = value.erro;
  const mensagem =
    typeof value.mensagem === 'string' ? value.mensagem.toLowerCase() : '';

  if (logado === false || erro === true) return true;
  if (
    mensagem.includes('token') &&
    (mensagem.includes('inv') || mensagem.includes('expir'))
  ) {
    return true;
  }

  return false;
}
