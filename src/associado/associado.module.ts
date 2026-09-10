import { Module } from '@nestjs/common';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { AuthModule } from 'src/auth/auth.module';
import { AssociadoController } from 'src/associado/controllers/associado.controller';
import { AssociadoService } from 'src/associado/services/associado.service';

@Module({
  imports: [HinovaModule, AuthModule],
  controllers: [AssociadoController],
  providers: [AssociadoService],
})
export class AssociadoModule {}
