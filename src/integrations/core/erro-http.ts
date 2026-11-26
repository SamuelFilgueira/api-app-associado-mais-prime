import axios, { AxiosError } from 'axios';

/**
 * O erro veio de uma chamada HTTP (axios)? Para o código de fora de
 * `src/integrations` que precisa LER a resposta de um erro de vendor sem
 * importar o axios — a regra de arquitetura só permite o axios aqui.
 */
export function ehErroHttp(erro: unknown): erro is AxiosError {
  return axios.isAxiosError(erro);
}
