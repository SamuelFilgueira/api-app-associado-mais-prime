import { Module } from '@nestjs/common';
import { ReinspectionController } from 'src/reinspection/controllers/reinspection.controller';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { SgaModule } from '../sga/sga.module';
import { ReinspectionPaymentsAdminController } from 'src/reinspection/controllers/reinspection-payments-admin.controller';
import { ReinspectionPaymentsAdminService } from 'src/reinspection/services/reinspection-payments-admin.service';

@Module({
  imports: [SgaModule],
  controllers: [ReinspectionController, ReinspectionPaymentsAdminController],
  providers: [ReinspectionService, ReinspectionPaymentsAdminService],
})
export class ReinspectionModule {}
