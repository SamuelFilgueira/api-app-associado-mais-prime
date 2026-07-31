import { Global, Module } from '@nestjs/common';
import { BaseContextService } from './base-context.service';
import { TokenResolverService } from './token-resolver.service';
import { SgaAuthService } from './sga-auth.service';

@Global()
@Module({
    providers: [TokenResolverService, BaseContextService, SgaAuthService],
    exports: [TokenResolverService, BaseContextService, SgaAuthService],
})
export class SharedModule {}
