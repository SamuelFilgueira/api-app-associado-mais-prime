import { Global, Module } from '@nestjs/common';
import { BaseContextService } from './base-context.service';
import { TokenResolverService } from './token-resolver.service';
import { ExternalApiConfigService } from './external-api-config.service';

@Global()
@Module({
    providers: [TokenResolverService, BaseContextService, ExternalApiConfigService],
    exports: [TokenResolverService, BaseContextService, ExternalApiConfigService],
})
export class SharedModule {}