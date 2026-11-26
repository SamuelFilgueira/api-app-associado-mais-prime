import { Injectable } from '@nestjs/common';
import { BaseOrigin } from 'src/config/tenant.config';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';

/**
 * Sessão do associado na Alloyal.
 *
 * O login devolve `uid`, `client` e `accessToken`; o app guarda os três e os
 * envia como cabeçalhos nas demais rotas. Nada da sessão fica no servidor:
 * este service não tem estado e atende todas as bases.
 */
@Injectable()
export class AlloyalSessaoService {
  constructor(private readonly alloyal: AlloyalGateway) {}

  /** A base decide o `api-secret` usado no login. */
  login(base: BaseOrigin, cpf: string, senha: string): Promise<SessaoAlloyal> {
    return this.alloyal.login(base, cpf, senha);
  }
}
