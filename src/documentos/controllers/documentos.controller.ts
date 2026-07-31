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
import { DocumentosService } from 'src/documentos/services/documentos.service';
import { CreateDocumentDto } from 'src/documentos/dto/create-document.dto';
import { UpdateDocumentDto } from 'src/documentos/dto/update-document.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AdminRoleGuard } from 'src/auth/guards/admin-role.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminPanelRoleGuard } from 'src/admin-panel/guards/admin-panel-role.guard';
import { AdminPanelRoles } from 'src/admin-panel/decorators/admin-panel-roles.decorator';
import {
  AdminPanelRole,
  ALL_ADMIN_PANEL_ROLES,
} from 'src/admin-panel/enums/admin-panel-role.enum';

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
