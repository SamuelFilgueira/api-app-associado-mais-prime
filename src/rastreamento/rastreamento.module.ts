import { Module } from '@nestjs/common';
import { RastreamentoController } from './rastreamento.controller';
import { RastreamentoService } from './rastreamento.service';
import { PrismaService } from 'src/prisma.service';
import { WebhookProcessor } from './webhook.processor';
import { NotificationsModule } from '../notifications/notifications.module';
import { SharedModule } from 'src/shared/shared.module';
import { RastreamentoSoftruck } from './softruck/rastreamento-softruck.service';
import { HistoricoSoftruckService } from './softruck/services/historico-softruck.service';
import { HistoricoPdfSoftruckService } from './softruck/pdf/historico-pdf-softruck.service';
import { GeomPipelineProcessor } from './softruck/processors/geom-pipeline.processor';
import { HistoricoResumoService } from './softruck/services/historico-resumo.service';
import { HistoricoResumoController } from './softruck/controllers/historico-resumo.controller';

@Module({
  imports: [NotificationsModule, SharedModule],
  controllers: [RastreamentoController, HistoricoResumoController],
  providers: [
    RastreamentoService,
    PrismaService,
    WebhookProcessor,
    RastreamentoSoftruck,
    HistoricoSoftruckService,
    HistoricoPdfSoftruckService,
    GeomPipelineProcessor,
    HistoricoResumoService,
  ],
})
export class RastreamentoModule {}
