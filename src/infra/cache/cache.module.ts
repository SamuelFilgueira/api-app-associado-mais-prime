import { Global, Module } from '@nestjs/common';
import { CacheService } from 'src/infra/cache/cache.service';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';

/**
 * Cache read-through e sessões de vendor, sobre o Redis compartilhado
 * (`RedisModule`). Global: qualquer módulo injeta sem redeclarar.
 */
@Global()
@Module({
  providers: [CacheService, VendorSessionStore],
  exports: [CacheService, VendorSessionStore],
})
export class CacheModule {}
