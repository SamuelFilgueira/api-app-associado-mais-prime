import {
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { BaseOrigin } from 'src/config/tenant.config';
import { SessaoAlloyal } from 'src/integrations/alloyal/alloyal.gateway';
import { exigirBase } from 'src/shared/tenant/tenant-context';

/**
 * Contexto de uma chamada à Alloyal, montado na borda a partir da
 * requisição: a base vem do JWT e a sessão do usuário na Alloyal vem dos
 * cabeçalhos `uid`, `client` e `access-token`, que o app envia a cada
 * chamada (a sessão não fica guardada no servidor).
 *
 * As duas checagens rodam DENTRO do corpo da rota (ver
 * `comErroDeContrato`): faltar base ou sessão responde o erro fixo da rota,
 * sem chamar a Alloyal — por isso as rotas usam
 * `@BaseOrigin({ opcional: true })` em vez da variante que responde 401.
 */
export interface CabecalhosDaSessao {
  uid?: string;
  client?: string;
  accessToken?: string;
}

export interface ContextoComSessao {
  base: BaseOrigin;
  sessao: SessaoAlloyal;
}

/** Base do JWT; precisa ser uma das bases deste deploy. */
export function baseDoToken(baseOrigin: string | undefined): BaseOrigin {
  if (!baseOrigin) {
    throw new UnauthorizedException('Base de origem não configurada no token');
  }
  return exigirBase(baseOrigin, 'rotas da Alloyal');
}

/** Sessão do usuário na Alloyal: os três cabeçalhos são obrigatórios. */
export function sessaoDoApp(cabecalhos: CabecalhosDaSessao): SessaoAlloyal {
  const { uid, client, accessToken } = cabecalhos;
  if (!uid || !client || !accessToken) {
    throw new HttpException(
      'Headers de autenticação da Alloyal ausentes (uid, client, access-token)',
      HttpStatus.UNAUTHORIZED,
    );
  }
  return { uid, client, accessToken };
}

export function contextoComSessao(
  baseOrigin: string | undefined,
  cabecalhos: CabecalhosDaSessao,
): ContextoComSessao {
  const sessao = sessaoDoApp(cabecalhos);
  return { base: baseDoToken(baseOrigin), sessao };
}
