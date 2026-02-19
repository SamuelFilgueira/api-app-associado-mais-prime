import { BoletoController } from './sga/boleto/boleto.controller';
import { BoletoService } from './sga/boleto/boleto.service';
import { Module } from '@nestjs/common';
import { RastreamentoModule } from './rastreamento/rastreamento.module';
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
import { SgaController } from './sga/sga.controller';
import { SgaService } from './sga/sga.service';
import { OficinaModule } from './oficina/oficina.module';
import { DocumentosModule } from './documentos/documentos.module';
import { AssociadoModule } from './associado/associado.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AlloyalApiModule } from './beneficios/alloyal-api.module';
import { AlloyalApiController } from './beneficios/alloyal-api.controller';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    QueueModule,
    AuthModule,
    RastreamentoModule,
    OficinaModule,
    DocumentosModule,
    AssociadoModule,
    NotificationsModule,
    AlloyalApiModule,
  ],
  controllers: [
    AppController,
    PostosController,
    CartaoController,
    EconomiaController,
    SgaController,
    BoletoController,
    AlloyalApiController,
  ],
  providers: [
    AppService,
    PostosService,
    PrismaService,
    CartaoService,
    EconomiaService,
    SgaService,
    BoletoService,
  ],
})
export class AppModule {}
