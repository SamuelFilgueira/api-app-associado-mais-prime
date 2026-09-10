import { Module } from '@nestjs/common';
import { M7Module } from 'src/rastreamento/m7/m7.module';
import { LogicaModule } from 'src/rastreamento/logica/logica.module';
import { HistoricoResumoController } from 'src/rastreamento/softruck/controllers/historico-resumo.controller';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { HistoricoSoftruckService } from 'src/rastreamento/softruck/services/historico-softruck.service';
import { HistoricoResumoService } from 'src/rastreamento/softruck/services/historico-resumo.service';
import { HistoricoProviderResolverService } from 'src/rastreamento/softruck/services/historico-provider-resolver.service';
import { HistoricoPdfSoftruckService } from 'src/rastreamento/softruck/pdf/historico-pdf-softruck.service';
import { GeomPipelineProcessor } from 'src/rastreamento/softruck/processors/geom-pipeline.processor';

/**
 * Provedor de rastreamento Softruck (posição, histórico, resumo, PDF).
 * Depende de M7 (reverse geocode) e de Lógica (fallback de histórico via
 * HistoricoProviderResolverService) — arestas explícitas nos imports.
 */
@Module({
  imports: [M7Module, LogicaModule],
  controllers: [HistoricoResumoController],
  providers: [
    RastreamentoSoftruck,
    HistoricoSoftruckService,
    HistoricoResumoService,
    HistoricoProviderResolverService,
    HistoricoPdfSoftruckService,
    GeomPipelineProcessor,
  ],
  exports: [RastreamentoSoftruck, HistoricoSoftruckService],
})
export class SoftruckModule {}
