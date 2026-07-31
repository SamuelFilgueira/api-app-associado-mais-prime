import { Module } from '@nestjs/common';
import { EconomiaService } from 'src/economia/services/economia.service';
import { EconomiaController } from 'src/economia/controllers/economia.controller';
import { ClubgasModule } from '../integrations/clubgas/clubgas.module';

@Module({
  imports: [ClubgasModule],
  controllers: [EconomiaController],
  providers: [EconomiaService],
  exports: [EconomiaService],
})
export class EconomiaModule {}
