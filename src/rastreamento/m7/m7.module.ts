import { Module } from '@nestjs/common';
import { HistoricoM7Controller } from 'src/rastreamento/m7/controllers/historico-m7.controller';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { HistoricoM7Service } from 'src/rastreamento/m7/services/historico-m7.service';
import { HistoricoPdfM7Service } from 'src/rastreamento/m7/pdf/historico-pdf-m7.service';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';
import { M7ViagensBuilderService } from 'src/rastreamento/m7/services/m7-viagens-builder.service';

/**
 * Provedor de rastreamento M7 (posição, histórico, PDF, reverse geocode).
 * Exporta apenas o que os outros provedores/orquestrador consomem.
 */
@Module({
  controllers: [HistoricoM7Controller],
  providers: [
    RastreamentoM7,
    HistoricoM7Service,
    HistoricoPdfM7Service,
    M7ReverseGeocodeService,
    M7ViagensBuilderService,
  ],
  exports: [RastreamentoM7, M7ReverseGeocodeService],
})
export class M7Module {}
