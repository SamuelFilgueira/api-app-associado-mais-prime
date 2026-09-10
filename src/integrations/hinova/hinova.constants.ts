/**
 * Constantes da integração Hinova (SGA).
 *
 * Fonte única da base URL da API Hinova — antes duplicada literal em 7 arquivos.
 * `boleto-notificacao.config.ts` a consome como default (sobrescrevível por env).
 */
export const SGA_BASE_URL = 'https://api.hinova.com.br/api/sga/v2';
