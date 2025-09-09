import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PostosController } from './postos/postos.controller';
import { PostosService } from './postos/postos.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [AuthModule],
  controllers: [AppController, PostosController],
  providers: [AppService, PostosService, PrismaService],
})
export class AppModule {}
