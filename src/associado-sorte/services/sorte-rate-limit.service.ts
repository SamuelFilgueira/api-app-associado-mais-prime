import { Injectable, Logger } from '@nestjs/common';
import {
  associadoSorteConfig,
  SorteLimiteRequisicoes,
} from 'src/associado-sorte/config/associado-sorte.config';
import { erro429 } from 'src/associado-sorte/helpers/sorte-erros';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';

export type SorteAcaoLimitada =
  | 'coletar'
  | 'participar'
  | 'resgatar'
  | 'raspar'
  | 'comprar';

/**
 * Limite leve de requisições por associado, na janela fixa atômica do
 * `LimitadorService` (antes eram `INCR` e `EXPIRE` separados: se o processo
 * caísse entre os dois, a chave ficava sem expiração e o associado em 429
 * para sempre). Se o Redis estiver fora, libera: as travas do banco continuam
 * garantindo a regra; o limite é só proteção contra abuso.
 */
@Injectable()
export class SorteRateLimitService {
  private readonly logger = new Logger(SorteRateLimitService.name);

  constructor(private readonly limitador: LimitadorService) {}

  async verificar(acao: SorteAcaoLimitada, userId: number): Promise<void> {
    const limite: SorteLimiteRequisicoes =
      associadoSorteConfig().rateLimit[acao];
    const chave = `sorte:rl:${acao}:${userId}`;

    let total: number;
    try {
      ({ total } = await this.limitador.consumir(chave, limite.janelaSeg));
    } catch (erro) {
      this.logger.warn(
        `Limite de requisições indisponível (Redis): ${(erro as Error).message}`,
      );
      return;
    }

    if (total > limite.max) {
      throw erro429('Muitas tentativas. Aguarde alguns segundos.');
    }
  }
}
