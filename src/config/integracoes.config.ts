/**
 * Endereços e limites de integrações que NÃO variam por base (os que variam
 * ficam no `TenantCredentialsRegistry`).
 */

const HINOVA_SGA_URL_PADRAO = 'https://api.hinova.com.br/api/sga/v2';

/**
 * Base URL da API Hinova (SGA). `HINOVA_SGA_BASE_URL` existe para apontar
 * testes de integração e de carga a um servidor simulado; em produção fica
 * sem definir.
 */
export function hinovaSgaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.HINOVA_SGA_BASE_URL?.trim().replace(/\/+$/, '') || HINOVA_SGA_URL_PADRAO
  );
}

/**
 * Orçamento de chamadas por token de base do SGA, por minuto. `0` (padrão)
 * só mede. A Hinova bloqueia o token por "extração de dados" acima de um
 * limiar que ela não publica; o valor deve vir da medição
 * (`vendor_requests_total{vendor="hinova"}`), abaixo do ponto em que os
 * bloqueios aparecem.
 */
export function hinovaOrcamentoPorMinuto(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const n = Number(env.HINOVA_ORCAMENTO_POR_MINUTO);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Prazos do cache das leituras da Hinova, em segundos. `0` desliga o cache
 * daquela leitura.
 *
 *  - HINOVA_CACHE_ASSOCIADO_SEG (300): `GET /associado/buscar/:cpf`, a
 *    consulta que o app dispara a cada abertura;
 *  - HINOVA_CACHE_BOLETOS_SEG (120): boletos por veículo;
 *  - HINOVA_CACHE_PRODUTOS_SEG (21600): produtos vinculados ao veículo;
 *  - HINOVA_CACHE_ANTIGO_SEG (0): por quanto tempo um valor VENCIDO ainda é
 *    servido se a Hinova estiver fora. Desligado por padrão: servir situação
 *    antiga do associado durante uma queda é decisão de produto, tela a tela.
 */
export interface PrazosDoCacheHinova {
  associadoSeg: number;
  boletosSeg: number;
  produtosSeg: number;
  antigoSeg: number;
}

export function prazosDoCacheHinova(
  env: NodeJS.ProcessEnv = process.env,
): PrazosDoCacheHinova {
  return {
    associadoSeg: lerSegundos(env.HINOVA_CACHE_ASSOCIADO_SEG, 300, 3_600),
    boletosSeg: lerSegundos(env.HINOVA_CACHE_BOLETOS_SEG, 120, 900),
    produtosSeg: lerSegundos(env.HINOVA_CACHE_PRODUTOS_SEG, 21_600, 86_400),
    antigoSeg: lerSegundos(env.HINOVA_CACHE_ANTIGO_SEG, 0, 86_400),
  };
}

/** Inteiro de segundos entre 0 e `max`; vazio ou inválido → `padrao`. */
function lerSegundos(
  valor: string | undefined,
  padrao: number,
  max: number,
): number {
  const n = Number(valor);
  if (valor === undefined || valor.trim() === '' || !Number.isFinite(n)) {
    return padrao;
  }
  return Math.min(max, Math.max(0, Math.trunc(n)));
}

// ── Alloyal (clube de vantagens) ───────────────────────────────────────

/** Origem das rotas administrativas quando `BASE_URL_ALLOYAL` não existe. */
const ALLOYAL_ORIGEM_PADRAO = 'https://api.lecupon.com';

/**
 * Prazo de cada chamada à Alloyal. Sem ele o axios espera indefinidamente e
 * a requisição do app fica presa até o proxy desistir.
 */
export const ALLOYAL_TIMEOUT_MS = 20_000;

/**
 * Configuração da Alloyal que NÃO varia por base (o que varia — api-secret,
 * business id e CNPJ — vem do `TenantCredentialsRegistry`).
 *
 *  - BASE_URL_ALLOYAL: endereço da API usada com a sessão do usuário
 *    (ex.: `https://api.lecupon.com/api/v1`). As rotas administrativas
 *    (`/client/v2/businesses/...`) usam só a ORIGEM desse endereço;
 *  - x_clientemployee_email / x_clientemployee_token: credencial de employee
 *    das rotas administrativas (a mesma para todas as bases).
 */
export interface AlloyalConfig {
  /** Base das rotas de sessão, sem barra final. Ausente = não configurada. */
  urlDaApi?: string;
  /** Origem (`https://host`) das rotas administrativas. Ausente = URL inválida. */
  origemAdministrativa?: string;
  employeeEmail?: string;
  employeeToken?: string;
  timeoutMs: number;
}

export function alloyalConfig(
  env: NodeJS.ProcessEnv = process.env,
): AlloyalConfig {
  const urlDaApi =
    env.BASE_URL_ALLOYAL?.trim().replace(/\/+$/, '') || undefined;

  return {
    urlDaApi,
    origemAdministrativa: origemDe(urlDaApi ?? ALLOYAL_ORIGEM_PADRAO),
    employeeEmail: env.x_clientemployee_email || undefined,
    employeeToken: env.x_clientemployee_token || undefined,
    timeoutMs: ALLOYAL_TIMEOUT_MS,
  };
}

function origemDe(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Prazos do cache do catálogo da Alloyal, em segundos. `0` desliga o cache
 * daquele recurso (toda leitura volta a ir à Alloyal).
 *
 *  - ALLOYAL_CACHE_CATEGORIAS_SEG (21600): categorias da base;
 *  - ALLOYAL_CACHE_DESTAQUES_SEG (10800): organizações online em destaque;
 *  - ALLOYAL_CACHE_ORGANIZACOES_SEG (3600): organizações sem coordenada,
 *    busca nem categoria.
 *
 * O cache parte da premissa de que o catálogo é IGUAL para todos os
 * associados da base. Se a Alloyal passar a segmentar ofertas por usuário
 * dentro do mesmo business, zere estas variáveis: é o desligamento sem
 * deploy.
 */
export interface PrazosDoCacheAlloyal {
  categoriasSeg: number;
  destaquesOnlineSeg: number;
  organizacoesSeg: number;
}

export function prazosDoCacheAlloyal(
  env: NodeJS.ProcessEnv = process.env,
): PrazosDoCacheAlloyal {
  return {
    categoriasSeg: lerSegundos(
      env.ALLOYAL_CACHE_CATEGORIAS_SEG,
      21_600,
      86_400,
    ),
    destaquesOnlineSeg: lerSegundos(
      env.ALLOYAL_CACHE_DESTAQUES_SEG,
      10_800,
      86_400,
    ),
    organizacoesSeg: lerSegundos(
      env.ALLOYAL_CACHE_ORGANIZACOES_SEG,
      3_600,
      86_400,
    ),
  };
}

// ── Suri (WhatsApp) ────────────────────────────────────────────────────

/**
 * Ids dos templates de WhatsApp da Suri. Ausente = o aviso não é enviado
 * (o `SuriNotificacaoService` registra e segue).
 *
 *  - suri_template_id: link do boleto de reativação, na geração;
 *  - suri_template_id_boleto_pago: aviso de boleto pago.
 */
export function suriTemplates(env: NodeJS.ProcessEnv = process.env): {
  boletoDeReativacao?: string;
  boletoPago?: string;
} {
  return {
    boletoDeReativacao: env.suri_template_id || undefined,
    boletoPago: env.suri_template_id_boleto_pago || undefined,
  };
}
