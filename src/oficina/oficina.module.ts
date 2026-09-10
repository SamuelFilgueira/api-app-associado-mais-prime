import { Module } from '@nestjs/common';
import { OficinaService } from 'src/oficina/services/oficina.service';
import { OficinaController } from 'src/oficina/controllers/oficina.controller';

@Module({
  providers: [OficinaService],
  controllers: [OficinaController],
})
export class OficinaModule {}
