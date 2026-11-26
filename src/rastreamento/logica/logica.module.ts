import { Module } from '@nestjs/common';
import { TrajetosController } from 'src/rastreamento/logica/controllers/trajetos.controller';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';
import { LogicaAuthService } from 'src/rastreamento/logica/services/logica-auth.service';
import { TrajetosService } from 'src/rastreamento/logica/services/trajetos.service';
import { TrajetoPdfLogicaService } from 'src/rastreamento/logica/pdf/trajeto-pdf-logica.service';
import { LogicaHistoricoService } from 'src/rastreamento/logica/services/logica-historico.service';
import { ProvedorLogica } from 'src/rastreamento/logica/services/logica-provedor';

/**
 * Provedor de rastreamento Lógica Soluções (posição, trajetos, histórico, PDF).
 */
@Module({
  controllers: [TrajetosController],
  providers: [
    LogicaRastreamentoService,
    ProvedorLogica,
    LogicaAuthService,
    TrajetosService,
    TrajetoPdfLogicaService,
    LogicaHistoricoService,
  ],
  exports: [
    LogicaRastreamentoService,
    ProvedorLogica,
    TrajetosService,
    LogicaHistoricoService,
  ],
})
export class LogicaModule {}
