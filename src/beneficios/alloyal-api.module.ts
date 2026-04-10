import { Module } from '@nestjs/common';
import { AlloyalApiService } from './alloyal-api.service';
import { SharedModule } from 'src/shared/shared.module';

@Module({
  imports: [SharedModule],
  providers: [AlloyalApiService],
  exports: [AlloyalApiService],
})
export class AlloyalApiModule {}
