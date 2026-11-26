import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';
import { RateLimitInterceptor } from 'src/infra/rate-limit/rate-limit.interceptor';

/**
 * Limite de requisições global (interceptor) e o contador atômico
 * (`LimitadorService`) reaproveitado pelos limites próprios de analytics e
 * do Associado da Sorte.
 */
@Global()
@Module({
  providers: [
    LimitadorService,
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
  exports: [LimitadorService],
})
export class RateLimitModule {}
