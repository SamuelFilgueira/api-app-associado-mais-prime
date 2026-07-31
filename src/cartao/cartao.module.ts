import { Module } from '@nestjs/common';
import { CartaoController } from 'src/cartao/controllers/cartao.controller';
import { CartaoService } from 'src/cartao/services/cartao.service';
import { FuelSessionModule } from '../fuel-session/fuel-session.module';
import { ClubgasModule } from '../integrations/clubgas/clubgas.module';

@Module({
  imports: [FuelSessionModule, ClubgasModule],
  controllers: [CartaoController],
  providers: [CartaoService],
})
export class CartaoModule {}
