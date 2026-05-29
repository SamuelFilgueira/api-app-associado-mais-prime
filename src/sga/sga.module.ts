import { Module } from '@nestjs/common';
import { SgaService } from './sga.service';
import { SgaController } from './sga.controller';

@Module({
  controllers: [SgaController],
  providers: [SgaService],
  exports: [SgaService],
})
export class SgaModule {}
