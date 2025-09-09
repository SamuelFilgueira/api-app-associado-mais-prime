import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PostosController } from './postos/postos.controller';
import { PostosService } from './postos/postos.service';
import { PrismaService } from './prisma.service';
import { CartaoController } from './cartao/cartao.controller';
import { CartaoService } from './cartao/cartao.service';
import { EconomiaController } from './economia/economia.controller';
import { EconomiaService } from './economia/economia.service';

@Module({
  imports: [AuthModule],
  controllers: [AppController, PostosController, CartaoController, EconomiaController],
  providers: [AppService, PostosService, PrismaService, CartaoService, EconomiaService],
})
export class AppModule {}
