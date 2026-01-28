import { Module } from '@nestjs/common';
import { OficinaService } from './oficina.service';
import { OficinaController } from './oficina.controller';
import { PrismaService } from '../prisma.service';

@Module({
  exports: [OficinaService],
  providers: [OficinaService, PrismaService],
  controllers: [OficinaController],
})
export class OficinaModule {}
