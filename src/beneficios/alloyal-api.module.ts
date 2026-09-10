import { Module } from '@nestjs/common';
import { AlloyalApiService } from 'src/beneficios/services/alloyal-api.service';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';

@Module({
  controllers: [AlloyalApiController],
  providers: [AlloyalApiService],
})
export class AlloyalApiModule {}
