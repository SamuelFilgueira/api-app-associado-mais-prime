import { hinovaSgaBaseUrl } from 'src/config/integracoes.config';

/**
 * Constantes da integração Hinova (SGA).
 *
 * Fonte única da base URL da API Hinova — antes duplicada literal em 7 arquivos.
 * `boleto-notificacao.config.ts` a consome como default (sobrescrevível por env).
 * O valor vem de `config/integracoes.config.ts` (env `HINOVA_SGA_BASE_URL`,
 * usada só para apontar testes a um servidor simulado).
 */
export const SGA_BASE_URL = hinovaSgaBaseUrl();

/**
 * Prazo do login (`POST /usuario/autenticar`). O login é compartilhado em voo
 * por todas as requisições da sessão: sem prazo, uma conexão pendurada
 * travava toda chamada daquele token de base até o processo reiniciar.
 */
export const SGA_TIMEOUT_LOGIN_MS = 15_000;

/**
 * Prazo padrão das chamadas ao SGA que não informam `timeout`. Fica abaixo
 * dos 60 s do proxy e do app, para a API sempre responder antes deles.
 * Chamadas sabidamente lentas (varreduras por período) passam o próprio prazo.
 */
export const SGA_TIMEOUT_PADRAO_MS = 45_000;

/**
 * Validade da sessão (`token_usuario`) guardada no Redis. A Hinova não
 * publica o prazo do token; passado este tempo a sessão é refeita, e antes
 * disso um 401 já provoca a reautenticação.
 */
export const SGA_SESSAO_TTL_SEG = 6 * 60 * 60;
