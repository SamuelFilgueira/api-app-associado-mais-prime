import { Module } from '@nestjs/common';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { BoletoController } from 'src/sga/boleto/controllers/boleto.controller';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';

@Module({
  imports: [HinovaModule],
  controllers: [BoletoController],
  providers: [BoletoService],
})
export class BoletoModule {}
