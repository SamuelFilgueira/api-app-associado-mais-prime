import { Module } from '@nestjs/common';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { ReinspectionController } from 'src/reinspection/controllers/reinspection.controller';
import { ReinspectionPaymentsAdminController } from 'src/reinspection/controllers/reinspection-payments-admin.controller';
import { ReinspectionHinovaRepository } from 'src/reinspection/repositories/reinspection-hinova.repository';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { ReinspectionAndamentoService } from 'src/reinspection/services/reinspection-andamento.service';
import { ReinspectionAprovacaoService } from 'src/reinspection/services/reinspection-aprovacao.service';
import { ReinspectionAvaliacaoService } from 'src/reinspection/services/reinspection-avaliacao.service';
import { ReinspectionConsultaService } from 'src/reinspection/services/reinspection-consulta.service';
import { ReinspectionEnvioService } from 'src/reinspection/services/reinspection-envio.service';
import { ReinspectionHinovaLoteService } from 'src/reinspection/services/reinspection-hinova-lote.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { ReinspectionPaymentsAdminService } from 'src/reinspection/services/reinspection-payments-admin.service';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { ReinspectionSubmissaoService } from 'src/reinspection/services/reinspection-submissao.service';
import { ReinspectionTemplateService } from 'src/reinspection/services/reinspection-template.service';
import { RevistoriaRegraService } from 'src/reinspection/services/revistoria-regra.service';
import { SgaModule } from '../sga/sga.module';

@Module({
  imports: [HinovaModule, SgaModule],
  controllers: [ReinspectionController, ReinspectionPaymentsAdminController],
  providers: [
    // Repositórios
    ReinspectionRepository,
    ReinspectionPhotoRepository,
    ReinspectionHinovaRepository,
    // Casos de uso
    ReinspectionEnvioService,
    ReinspectionSubmissaoService,
    ReinspectionAndamentoService,
    ReinspectionAvaliacaoService,
    ReinspectionAprovacaoService,
    ReinspectionConsultaService,
    ReinspectionTemplateService,
    ReinspectionHinovaLoteService,
    ReinspectionHinovaService,
    ReinspectionPaymentsAdminService,
    RevistoriaRegraService,
    // Fachada usada pelo controller
    ReinspectionService,
  ],
})
export class ReinspectionModule {}
