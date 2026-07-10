import { Module } from '@nestjs/common';
import { RastreamentoController } from './rastreamento.controller';
import { RastreamentoService } from './rastreamento.service';
import { WebhookProcessor } from './webhook.processor';
import { NotificationsModule } from '../notifications/notifications.module';
import { SharedModule } from 'src/shared/shared.module';
import { RastreamentoSoftruck } from './softruck/rastreamento-softruck.service';
import { HistoricoSoftruckService } from './softruck/services/historico-softruck.service';
import { HistoricoPdfSoftruckService } from './softruck/pdf/historico-pdf-softruck.service';
import { GeomPipelineProcessor } from './softruck/processors/geom-pipeline.processor';
import { HistoricoResumoService } from './softruck/services/historico-resumo.service';
import { HistoricoResumoController } from './softruck/controllers/historico-resumo.controller';
import { HistoricoM7Controller } from './m7/controllers/historico-m7.controller';
import { HistoricoM7Service } from './m7/services/historico-m7.service';
import { HistoricoPdfM7Service } from './m7/pdf/historico-pdf-m7.service';
import { M7ReverseGeocodeService } from './m7/services/m7-reverse-geocode.service';
import { M7ViagensBuilderService } from './m7/services/m7-viagens-builder.service';
import { RastreamentoM7 } from './rastreamento-m7';
import { LogicaRastreamentoService } from './rastreamento.logica';

@Module({
  imports: [NotificationsModule, SharedModule],
  controllers: [RastreamentoController, HistoricoResumoController, HistoricoM7Controller],
  providers: [
    RastreamentoService,
    WebhookProcessor,
    RastreamentoM7,
    LogicaRastreamentoService,
    RastreamentoSoftruck,
    HistoricoSoftruckService,
    HistoricoPdfSoftruckService,
    GeomPipelineProcessor,
    HistoricoResumoService,
    HistoricoM7Service,
    HistoricoPdfM7Service,
    M7ReverseGeocodeService,
    M7ViagensBuilderService,
  ],
})
export class RastreamentoModule {}
