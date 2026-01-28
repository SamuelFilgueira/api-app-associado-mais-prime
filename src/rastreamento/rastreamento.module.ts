import { Module } from '@nestjs/common';
import { RastreamentoController } from './rastreamento.controller';
import { RastreamentoService } from './rastreamento.service';
import { PrismaService } from 'src/prisma.service';

@Module({
  controllers: [RastreamentoController],
  providers: [RastreamentoService, PrismaService],
})
export class RastreamentoModule {}
