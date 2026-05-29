import { BoletoController } from './sga/boleto/boleto.controller';
import { BoletoService } from './sga/boleto/boleto.service';
import { BeneficiosVeiculoController } from './sga/beneficios-veiculo/beneficios-veiculo/beneficios-veiculo.controller';
import { BeneficiosVeiculoService } from './sga/beneficios-veiculo/beneficios-veiculo/beneficios-veiculo.service';
import { BoletoVerificacaoProcessor } from './sga/boleto-verificacao.processor';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { InfraModule } from './infra/infra.module';
import { StorageModule } from './storage/storage.module';
import { RastreamentoModule } from './rastreamento/rastreamento.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PostosController } from './postos/postos.controller';
import { PostosService } from './postos/postos.service';
import { CartaoController } from './cartao/cartao.controller';
import { CartaoService } from './cartao/cartao.service';
import { SgaModule } from './sga/sga.module';
import { EconomiaModule } from './economia/economia.module';
import { OficinaModule } from './oficina/oficina.module';
import { DocumentosModule } from './documentos/documentos.module';
import { AssociadoModule } from './associado/associado.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AlloyalApiModule } from './beneficios/alloyal-api.module';
import { AlloyalApiController } from './beneficios/alloyal-api.controller';
import { QueueModule } from './queue/queue.module';
import { ReinspectionModule } from './reinspection/reinspection.module';
import { SliderModule } from './slider/slider.module';
import { AdminPanelModule } from './admin-panel/admin-panel.module';
import { FuelSessionModule } from './fuel-session/fuel-session.module';

@Module({
  imports: [
    DatabaseModule,
    InfraModule,
    StorageModule,
    QueueModule,
    AuthModule,
    RastreamentoModule,
    OficinaModule,
    DocumentosModule,
    AssociadoModule,
    NotificationsModule,
    AlloyalApiModule,
    SgaModule,
    EconomiaModule,
    ReinspectionModule,
    SliderModule,
    AdminPanelModule,
    FuelSessionModule,
  ],
  controllers: [
    AppController,
    PostosController,
    CartaoController,
    BoletoController,
    BeneficiosVeiculoController,
    AlloyalApiController,
  ],
  providers: [
    AppService,
    PostosService,
    CartaoService,
    BoletoService,
    BeneficiosVeiculoService,
    BoletoVerificacaoProcessor,
  ],
})
export class AppModule {}
