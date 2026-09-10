import { Global, Module } from '@nestjs/common';
import { BaseContextService } from './base-context.service';
import { TokenResolverService } from './token-resolver.service';

/**
 * Transversal de tenancy (agnóstico de vendor). Autenticação Hinova vive em
 * `src/integrations/hinova` (HinovaModule).
 */
@Global()
@Module({
  providers: [TokenResolverService, BaseContextService],
  exports: [TokenResolverService, BaseContextService],
})
export class SharedModule {}
