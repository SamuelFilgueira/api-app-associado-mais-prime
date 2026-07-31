import { Module } from '@nestjs/common';
import { BoletoController } from 'src/sga/boleto/controllers/boleto.controller';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';

@Module({
  controllers: [BoletoController],
  providers: [BoletoService],
})
export class BoletoModule {}
