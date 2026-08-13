import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AdminPanelRole } from 'src/admin-panel/enums/admin-panel-role.enum';
import { AdminPanelRoleGuard } from 'src/admin-panel/guards/admin-panel-role.guard';
import { AdminPanelRoles } from 'src/admin-panel/decorators/admin-panel-roles.decorator';
import { ListReinspectionPaymentsDto } from 'src/reinspection/dto/list-reinspection-payments.dto';
import { ReinspectionPaymentsAdminService } from 'src/reinspection/services/reinspection-payments-admin.service';

@UseGuards(JwtAuthGuard, AdminPanelRoleGuard)
@AdminPanelRoles(AdminPanelRole.COBRANCA)
@Controller('admin-panel/reinspection-payments')
export class ReinspectionPaymentsAdminController {
  constructor(
    private readonly reinspectionPaymentsAdminService: ReinspectionPaymentsAdminService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Query() query: ListReinspectionPaymentsDto) {
    return this.reinspectionPaymentsAdminService.list(query);
  }

  @Get('vehicle/:userVehicleId')
  @HttpCode(HttpStatus.OK)
  listByUserVehicle(
    @Param('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionPaymentsAdminService.listByUserVehicle(
      userVehicleId,
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  getById(@Param('id', ParseIntPipe) id: number) {
    return this.reinspectionPaymentsAdminService.getById(id);
  }

  @Patch(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.reinspectionPaymentsAdminService.cancel(id);
  }
}
