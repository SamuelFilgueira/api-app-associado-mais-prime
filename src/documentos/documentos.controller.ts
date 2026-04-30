import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DocumentosService } from './documentos.service';
import { CreateDocumentDto } from './DTOs/create-document.dto';
import { UpdateDocumentDto } from './DTOs/update-document.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';
import { AdminPanelRoles } from '../admin-panel/admin-panel-roles.decorator';
import {
  AdminPanelRole,
  ALL_ADMIN_PANEL_ROLES,
} from '../admin-panel/admin-panel-role.enum';

@UseGuards(JwtAuthGuard)
@Controller('documentos')
export class DocumentosController {
  constructor(private readonly documentosService: DocumentosService) {}

  @UseGuards(AdminRoleGuard, AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  create(
    @Body() data: CreateDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.documentosService.create(data, file);
  }

  @Get()
  //@UseGuards(AdminPanelRoleGuard)
  //@AdminPanelRoles(AdminPanelRole.EVENTOS)
  findAll() {
    return this.documentosService.findAll();
  }

  @Get('total')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(...ALL_ADMIN_PANEL_ROLES)
  getTotalDocuments() {
    return this.documentosService.getTotalDocuments();
  }

  @Get(':id')
  //@UseGuards(AdminPanelRoleGuard)
  //@AdminPanelRoles(AdminPanelRole.EVENTOS)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.documentosService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateDocumentDto,
  ) {
    return this.documentosService.update(id, data);
  }

  @UseGuards(AdminRoleGuard, AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.documentosService.remove(id);
  }
}
