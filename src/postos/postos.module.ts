import { Module } from '@nestjs/common';
import { PostosController } from 'src/postos/controllers/postos.controller';
import { PostosService } from 'src/postos/services/postos.service';
import { ClubgasModule } from '../integrations/clubgas/clubgas.module';

@Module({
  imports: [ClubgasModule],
  controllers: [PostosController],
  providers: [PostosService],
})
export class PostosModule {}
