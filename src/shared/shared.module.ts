import { Global, Module } from '@nestjs/common';
import { BaseContextService } from './base-context.service';
import { TokenResolverService } from './token-resolver.service';
import { ExternalApiConfigService } from './external-api-config.service';
import { SgaAuthService } from './sga-auth.service';

@Global()
@Module({
    providers: [TokenResolverService, BaseContextService, ExternalApiConfigService, SgaAuthService],
    exports: [TokenResolverService, BaseContextService, ExternalApiConfigService, SgaAuthService],
})
export class SharedModule {}