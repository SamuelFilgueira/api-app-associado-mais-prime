import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	ParseIntPipe,
	Patch,
	Post,
} from '@nestjs/common';
import { DocumentosService } from './documentos.service';
import { CreateDocumentDto } from './DTOs/create-document.dto';
import { UpdateDocumentDto } from './DTOs/update-document.dto';

@Controller('documentos')
export class DocumentosController {
	constructor(private readonly documentosService: DocumentosService) {}

	@Post()
	create(@Body() data: CreateDocumentDto) {
		return this.documentosService.create(data);
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

	@Delete(':id')
	remove(@Param('id', ParseIntPipe) id: number) {
		return this.documentosService.remove(id);
	}
}
