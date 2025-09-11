import { Module } from '@nestjs/common';
import { RastreamentoController } from './rastreamento.controller';
import { RastreamentoService } from './rastreamento.service';

@Module({
  controllers: [RastreamentoController],
  providers: [RastreamentoService],
})
export class RastreamentoModule {}
