import { Module } from '@nestjs/common';
import { AlloyalApiService } from 'src/beneficios/services/alloyal-api.service';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { alloyalRedisProvider } from 'src/beneficios/providers/alloyal-redis.provider';

@Module({
  controllers: [AlloyalApiController],
  providers: [
    AlloyalApiService,
    alloyalRedisProvider,
    AlloyalCategoriesCacheService,
  ],
  exports: [AlloyalCategoriesCacheService],
})
export class AlloyalApiModule {}
