import { Module } from '@nestjs/common';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { WebhookProcessor } from 'src/rastreamento/processors/webhook.processor';
import { NotificationsModule } from '../notifications/notifications.module';
import { SharedModule } from 'src/shared/shared.module';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
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
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';
import { TrajetosController } from './logica/controllers/trajetos.controller';
import { TrajetosService } from './logica/services/trajetos.service';
import { TrajetoPdfLogicaService } from './logica/pdf/trajeto-pdf-logica.service';

@Module({
  imports: [NotificationsModule, SharedModule],
  controllers: [
    RastreamentoController,
    HistoricoResumoController,
    HistoricoM7Controller,
    TrajetosController,
  ],
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
    TrajetosService,
    TrajetoPdfLogicaService,
  ],
})
export class RastreamentoModule {}
