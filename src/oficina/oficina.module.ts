import { Module } from '@nestjs/common';
import { OficinaService } from 'src/oficina/services/oficina.service';
import { OficinaController } from 'src/oficina/controllers/oficina.controller';

@Module({
  exports: [OficinaService],
  providers: [OficinaService],
  controllers: [OficinaController],
})
export class OficinaModule {}
