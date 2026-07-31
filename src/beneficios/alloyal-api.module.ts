import { Module } from '@nestjs/common';
import { AlloyalApiService } from 'src/beneficios/services/alloyal-api.service';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { SharedModule } from 'src/shared/shared.module';

@Module({
  imports: [SharedModule],
  controllers: [AlloyalApiController],
  providers: [AlloyalApiService],
  exports: [AlloyalApiService],
})
export class AlloyalApiModule {}
