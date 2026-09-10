import { Module } from '@nestjs/common';
import { TrajetosController } from 'src/rastreamento/logica/controllers/trajetos.controller';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';
import { LogicaAuthService } from 'src/rastreamento/logica/services/logica-auth.service';
import { TrajetosService } from 'src/rastreamento/logica/services/trajetos.service';
import { TrajetoPdfLogicaService } from 'src/rastreamento/logica/pdf/trajeto-pdf-logica.service';
import { LogicaHistoricoService } from 'src/rastreamento/logica/services/logica-historico.service';

/**
 * Provedor de rastreamento Lógica Soluções (posição, trajetos, histórico, PDF).
 */
@Module({
  controllers: [TrajetosController],
  providers: [
    LogicaRastreamentoService,
    LogicaAuthService,
    TrajetosService,
    TrajetoPdfLogicaService,
    LogicaHistoricoService,
  ],
  exports: [LogicaRastreamentoService, TrajetosService, LogicaHistoricoService],
})
export class LogicaModule {}
