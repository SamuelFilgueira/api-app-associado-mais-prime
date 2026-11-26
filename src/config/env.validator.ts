import { Logger } from '@nestjs/common';
import { TENANT, tenantEnvName } from './tenant.config';

// Variáveis obrigatórias independentes de tenant — app NÃO sobe sem elas
const REQUIRED_BASE = [
  'JWT_SECRET',
  'DATABASE_URL',
  'REDIS_HOST',
  'ANALYTICS_SECRET',
];

// Variáveis importantes — app sobe mas emite warning visível
const WARN_IF_MISSING = [
  'GMAIL_USER',
  'SENHA_APP',
  'ADMIN_PANEL_TOKEN',
  'TOKEN_API_CLUBGAS',
  'BASE_URL_ALLOYAL',
  'M7_API_BASE_URL',
  'M7_WEBHOOK_TOKEN',
  'LOGICA_API_BASE_URL',
  'LOGICA_API_NUMBER',
  'SOFTRUCK_API_BASE_URL',
  //'PUPPETEER_EXECUTABLE_PATH',
  'suri_baseUrl',
  'token_suri',
  'suri_template_id',
  'suri_template_id_boleto_pago',
  'channelId',
  'sendTo',
  'x_clientemployee_email',
  'x_clientemployee_token',
  // Rotina de notificações de boleto (opt-in explícito; demais envs têm default)
  'BOLETO_NOTIFICACAO_ENABLED',
  // E-mail transacional via Amazon SES (mail.service.ts usa `!` nessas envs:
  // sem elas o app sobe e o envio falha só em runtime, dentro de catch)
  'MAIL_FROM',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  // Geração de PDFs (Puppeteer) — obrigatório no Docker (Chromium do sistema)
  'PUPPETEER_EXECUTABLE_PATH',
  // ClubGas (clubgas.client.ts) — sem ela o client monta URL inválida
  'CLUBGAS_BASE_URL',
];

/**
 * Envs OPCIONAIS conhecidas — documentação viva; não geram warning.
 * Ao adicionar uma env nova, classifique-a aqui, em WARN_IF_MISSING ou
 * em REQUIRED_BASE (regra do CLAUDE.md).
 *
 * - APP_URL: base pública para links de upload (file-upload.service, tenant.config)
 * - TENANT_BRAND_COLOR: cor hex da marca nos PDFs (default #FF0000; Hertz usa laranja)
 * - PORT / REDIS_PORT / APP_TIMEZONE: infra com default
 * - PRISMA_CONNECTION_LIMIT / PRISMA_POOL_TIMEOUT: pool MySQL (prisma.service)
 * - CEPABERTO_TOKEN / CEPABERTO_API_TOKEN: geocodificação de oficinas
 *   (oficina.service aceita os dois nomes; sem token, oficina fica sem coordenadas)
 * - ENABLE_TEST_ENDPOINTS: habilita rotas de teste (auth.controller)
 * - M7_NOMINATIM_DB / M7_NOMINATIM_TABLE / M7_NOMINATIM_ENABLED: banco local de
 *   reverse geocode M7 (defaults no service)
 * - M7_REV_GEOCODE_CONCURRENCY / M7_REV_GEOCODE_HERANCA_METROS /
 *   M7_REV_GEOCODE_MEM_CACHE_MAX / M7_REV_GEOCODE_BUDGET_MS /
 *   M7_REV_GEOCODE_REDIS_TTL_SEG / M7_CONTESTACAO_INTERVALO_MIN_SEG /
 *   M7_CONTESTACAO_CHUNK_PONTOS: knobs do reverse geocode e do PDF de
 *   contestação V2 (defaults e limites em m7-geocode.config.ts)
 * - SOFTRUCK_REV_GEOCODE_TIMEOUT_MS: timeout do reverse geocode Softruck
 * - ANALYTICS_JOURNEY_ENABLED / ANALYTICS_LINK_USER_ENABLED /
 *   ANALYTICS_RATE_LIMIT_ENABLED / ANALYTICS_JOURNEY_TTL_DAYS: flags do analytics
 * - BOLETO_NOTIFICACAO_*: demais knobs da rotina de boletos (defaults validados
 *   em boleto-notificacao.config.ts)
 * - TOKEN_BASE_SGA_<BASE>1, …2 (até 9): tokens de base alternativos do SGA para
 *   failover quando a Hinova bloqueia um deles (token-resolver / sga-auth.service)
 * - BOLETO_VERIFICACAO_MAX_DIAS / BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN /
 *   BOLETO_VERIFICACAO_INTERVALO_APOS_7D_MIN / BOLETO_VERIFICACAO_ESPACAMENTO_MS:
 *   limites do poller de boleto de reativação (defaults e faixas em
 *   sga/config/boleto-verificacao.config.ts)
 * - BOLETO_REATIVACAO_RETRY_INTERVALO_MIN / BOLETO_REATIVACAO_RETRY_MAX_HORAS /
 *   BOLETO_REATIVACAO_JANELA_VENCIMENTO_DIAS: retry da criação do boleto de
 *   reativação após instabilidade do SGA (sga/config/boleto-reativacao-retry.config.ts)
 * - ASSOCIADO_SORTE_AGENDADOR: `true` liga o job periódico do Associado da
 *   Sorte (default DESLIGADO; associado-sorte/config/associado-sorte.config.ts)
 * - ASSOCIADO_SORTE_PAINEL_URL (link do e-mail de retirada; vazio omite o botão) /
 *   ASSOCIADO_SORTE_LEMBRETE_LOTE (pushes de lembrete por ciclo, padrão 500):
 *   opcionais, lidos em associado-sorte/config/associado-sorte.config.ts
 * - MAIL_PASSWORD_RESET_PROVIDER: ses (default) | gmail — provedor do e-mail de
 *   redefinição de senha (mail.config.ts). Hertz usa gmail; Mais Prime, ses.
 * - APP_ROLE: papel do processo — api | worker | pdf | all (default `all`,
 *   processo único). Valor inválido derruba o boot (config/app.config.ts)
 * - LOG_FORMAT (json | text; json em produção) / LOG_LEVEL / LOG_REDIGIR_PII:
 *   formato, nível e redação de CPF/token nas linhas de log
 * - TRUST_PROXY: `trust proxy` do Express (nº de proxies, lista de faixas ou
 *   false). Default: confia no X-Forwarded-For só vindo de rede interna
 * - CORS_ORIGINS: origens do painel aceitas no CORS, separadas por vírgula.
 *   Sem ela o CORS segue aberto (aviso no boot em produção)
 * - SWAGGER_ENABLED: sobe `/docs` (default: só fora de produção)
 * - METRICS_ENABLED / METRICS_TOKEN: `/metrics` do Prometheus. Sem token,
 *   responde só a rede interna; com token, exige Bearer
 * - RATE_LIMIT_ENABLED / RATE_LIMIT_ENFORCE_ALL: liga o limitador e aplica
 *   também as políticas que nascem em observação (infra/rate-limit)
 * - BODY_LIMIT_PADRAO (1mb) / BODY_LIMIT_GRANDE (20mb): teto do corpo JSON;
 *   o grande vale só nas rotas listadas em config/app.config.ts
 * - PDF_CONCORRENCIA / PDF_PRAZO_MS: renderizações simultâneas do processo
 *   `pdf` e quanto a API espera o job antes de responder 504
 * - REDIS_PASSWORD / REDIS_USERNAME / REDIS_DB: conexão do Redis
 *   (config/redis.config.ts). Senha ausente gera aviso em produção
 * - PDF_TMP_DIR: diretório de troca de arquivos entre a API e o processo
 *   `pdf` (config/app.config.ts; no compose é o volume `pdf-tmp`)
 * - HINOVA_CACHE_ASSOCIADO_SEG / HINOVA_CACHE_BOLETOS_SEG /
 *   HINOVA_CACHE_PRODUTOS_SEG / HINOVA_CACHE_ANTIGO_SEG: prazos do cache das
 *   leituras da Hinova; HINOVA_ORCAMENTO_POR_MINUTO: orçamento de chamadas
 *   por token de base; HINOVA_SGA_BASE_URL: servidor simulado, só para
 *   testes (config/integracoes.config.ts)
 * - ALLOYAL_CACHE_CATEGORIAS_SEG / ALLOYAL_CACHE_DESTAQUES_SEG /
 *   ALLOYAL_CACHE_ORGANIZACOES_SEG: prazos do cache do catálogo da Alloyal;
 *   0 desliga o cache daquele recurso (config/integracoes.config.ts)
 * - M7_REV_GEOCODE_MAX_CONSULTAS: teto global de consultas simultâneas ao
 *   Nominatim; padrão derivado de PRISMA_CONNECTION_LIMIT
 * - RETENCAO_NOTIFICACOES_DIAS / RETENCAO_WEBHOOK_EVENTOS_DIAS /
 *   RETENCAO_VERSAO_LOG_DIAS / RETENCAO_ANALYTICS_RECIBOS_DIAS (0 = não
 *   expurga) e RETENCAO_OUTBOX_DIAS / RETENCAO_PUSH_ENTREGAS_DIAS: política
 *   do expurgo diário (config/retencao.config.ts)
 * - EXPO_UPDATES_DIR / EXPO_UPDATES_PUBLIC_URL / EXPO_UPDATES_PRIVATE_KEY_PATH /
 *   EXPO_UPDATES_PRIVATE_KEY_BASE64 / EXPO_UPDATES_KEY_ID /
 *   EXPO_UPDATES_UPLOAD_LIMIT_MB: servidor OTA self-hosted (expo-updates.config.ts
 *   loga warning no boot se a chave de code signing estiver ausente)
 */

/**
 * Monta a lista de envs obrigatórias das integrações, por base configurada.
 *
 * Quais integrações entram é controlado por `TENANT_REQUIRED_INTEGRATIONS`
 * (default: `sga,softruckPublicKey,logica`). Uma empresa que ainda não
 * contratou Softruck ou Lógica pode reduzir a lista sem tocar em código.
 *
 * `LOGICA_TOKEN` é exigido apenas da base padrão, replicando o
 * comportamento anterior à parametrização.
 */
function requiredTenantEnvVars(): string[] {
  const vars = new Set<string>();

  for (const base of TENANT.baseNames) {
    for (const kind of TENANT.requiredIntegrations) {
      if (kind === 'logica' && base !== TENANT.defaultBase) {
        continue;
      }
      vars.add(tenantEnvName(base, kind));
    }
  }

  return [...vars];
}

export function validateEnvOrThrow() {
  const logger = new Logger('EnvValidator');

  logger.log(
    `Tenant: ${TENANT.name} | bases=[${TENANT.baseNames.join(', ')}] | base padrão=${TENANT.defaultBase}`,
  );

  const required = [...REQUIRED_BASE, ...requiredTenantEnvVars()];

  // TOKEN_BASE_SGA_<BASE> aceita variantes numeradas (…1, …2) para failover
  // de token bloqueado pela Hinova — qualquer uma presente satisfaz.
  const envPresente = (k: string): boolean => {
    if (process.env[k]) return true;
    if (!k.startsWith('TOKEN_BASE_SGA_')) return false;
    return Array.from({ length: 9 }, (_, i) => `${k}${i + 1}`).some(
      (n) => !!process.env[n],
    );
  };
  const missing = required.filter((k) => !envPresente(k));
  if (missing.length) {
    logger.error(`Variáveis de ambiente ausentes: ${missing.join(', ')}`);
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  const warned = WARN_IF_MISSING.filter((k) => !process.env[k]);
  if (warned.length) {
    logger.warn(
      `Variáveis de ambiente não configuradas (funcionalidades podem estar indisponíveis): ${warned.join(', ')}`,
    );
  }

  // Em produção o Redis guarda filas, sessões de vendor e limites: não deve
  // aceitar conexão anônima. Aviso (e não erro) para não derrubar quem ainda
  // roda o Redis só em rede interna.
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_PASSWORD) {
    logger.warn(
      'REDIS_PASSWORD não definida: configure `requirepass` no Redis e informe a senha.',
    );
  }

  logger.log('Environment variables validated');
}
