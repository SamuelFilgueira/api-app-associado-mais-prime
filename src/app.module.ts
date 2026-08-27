import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { InfraModule } from './infra/infra.module';
import { SharedModule } from './shared/shared.module';
import { QueueModule } from './queue/queue.module';
import { RastreamentoModule } from './rastreamento/rastreamento.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PostosModule } from './postos/postos.module';
import { CartaoModule } from './cartao/cartao.module';
import { SgaModule } from './sga/sga.module';
import { BoletoModule } from './sga/boleto/boleto.module';
import { BeneficiosVeiculoModule } from 'src/sga/beneficios-veiculo/beneficios-veiculo.module';
import { EconomiaModule } from './economia/economia.module';
import { OficinaModule } from './oficina/oficina.module';
import { DocumentosModule } from './documentos/documentos.module';
import { AssociadoModule } from './associado/associado.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AlloyalApiModule } from './beneficios/alloyal-api.module';
import { ReinspectionModule } from './reinspection/reinspection.module';
import { SliderModule } from './slider/slider.module';
import { AdminPanelModule } from './admin-panel/admin-panel.module';
import { FuelSessionModule } from './fuel-session/fuel-session.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AppVersionModule } from './app-version/app-version.module';
import { BoletoNotificacaoModule } from './boleto-notificacao/boleto-notificacao.module';

@Module({
  imports: [
    // Módulos globais de infraestrutura
    DatabaseModule,
    InfraModule,
    SharedModule,
    QueueModule,
    // Módulos de domínio
    AuthModule,
    AssociadoModule,
    SgaModule,
    BoletoModule,
    BeneficiosVeiculoModule,
    RastreamentoModule,
    PostosModule,
    CartaoModule,
    EconomiaModule,
    FuelSessionModule,
    OficinaModule,
    DocumentosModule,
    NotificationsModule,
    AlloyalApiModule,
    ReinspectionModule,
    SliderModule,
    AdminPanelModule,
    AnalyticsModule,
    AppVersionModule,
    BoletoNotificacaoModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
