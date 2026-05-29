import { Module } from '@nestjs/common';
import { EconomiaService } from './economia.service';
import { EconomiaController } from './economia.controller';

@Module({
  controllers: [EconomiaController],
  providers: [EconomiaService],
  exports: [EconomiaService],
})
export class EconomiaModule {}
