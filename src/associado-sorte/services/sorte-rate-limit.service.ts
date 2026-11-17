import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import {
  associadoSorteConfig,
  SorteLimiteRequisicoes,
} from 'src/associado-sorte/config/associado-sorte.config';
import { erro429 } from 'src/associado-sorte/helpers/sorte-erros';
import { SORTE_REDIS } from 'src/associado-sorte/providers/sorte-redis.provider';

export type SorteAcaoLimitada =
  | 'coletar'
  | 'participar'
  | 'resgatar'
  | 'raspar'
  | 'comprar';

/**
 * Limite leve de requisições por associado (`INCR` + `EXPIRE`, mesmo molde
 * de `analytics.service.ts`). Se o Redis estiver fora, libera: as travas do
 * banco continuam garantindo a regra; o limite é só proteção contra abuso.
 */
@Injectable()
export class SorteRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(SorteRateLimitService.name);

  constructor(@Inject(SORTE_REDIS) private readonly redis: Redis) {}

  async verificar(acao: SorteAcaoLimitada, userId: number): Promise<void> {
    const limite: SorteLimiteRequisicoes =
      associadoSorteConfig().rateLimit[acao];
    const chave = `sorte:rl:${acao}:${userId}`;

    let total: number;
    try {
      total = await this.redis.incr(chave);
      if (total === 1) {
        await this.redis.expire(chave, limite.janelaSeg);
      }
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

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
