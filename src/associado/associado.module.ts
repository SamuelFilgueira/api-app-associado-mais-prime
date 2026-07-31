import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { SharedModule } from 'src/shared/shared.module';
import { AssociadoController } from 'src/associado/controllers/associado.controller';
import { AssociadoService } from 'src/associado/services/associado.service';

@Module({
  imports: [AuthModule, SharedModule],
  controllers: [AssociadoController],
  providers: [AssociadoService],
})
export class AssociadoModule {}
