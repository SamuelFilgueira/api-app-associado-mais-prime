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

@UseGuards(JwtAuthGuard)
@Controller('documentos')
export class DocumentosController {
  constructor(private readonly documentosService: DocumentosService) {}

  @UseGuards(AdminRoleGuard)
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  create(
    @Body() data: CreateDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.documentosService.create(data, file);
  }

  @Get()
  findAll() {
    return this.documentosService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.documentosService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateDocumentDto,
  ) {
    return this.documentosService.update(id, data);
  }

  @UseGuards(AdminRoleGuard)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.documentosService.remove(id);
  }
}
