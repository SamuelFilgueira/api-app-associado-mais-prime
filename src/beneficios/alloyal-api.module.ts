import { Module } from '@nestjs/common';
import { AlloyalApiService } from './alloyal-api.service';

@Module({
  providers: [AlloyalApiService],
  exports: [AlloyalApiService],
})
export class AlloyalApiModule {}
