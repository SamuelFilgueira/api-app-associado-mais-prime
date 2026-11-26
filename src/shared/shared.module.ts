import { Global, Module } from '@nestjs/common';
import { TokenResolverService } from './token-resolver.service';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * Transversal de tenancy (agnóstico de vendor). Autenticação Hinova vive em
 * `src/integrations/hinova` (HinovaModule).
 */
@Global()
@Module({
  providers: [TenantCredentialsRegistry, TokenResolverService],
  exports: [TenantCredentialsRegistry, TokenResolverService],
})
export class SharedModule {}
