import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateDocumentDto } from './DTOs/create-document.dto';
import { UpdateDocumentDto } from './DTOs/update-document.dto';

@Injectable()
export class DocumentosService {
	constructor(private readonly prisma: PrismaService) {}

	async create(data: CreateDocumentDto) {
		return this.prisma.document.create({ data });
	}

	async findAll() {
		return this.prisma.document.findMany({
			orderBy: { createdAt: 'desc' },
		});
	}

	async findOne(id: number) {
		const document = await this.prisma.document.findUnique({
			where: { id },
		});

		if (!document) {
			throw new NotFoundException('Documento nao encontrado');
		}

		return document;
	}

	async update(id: number, data: UpdateDocumentDto) {
		await this.findOne(id);

		return this.prisma.document.update({
			where: { id },
			data,
		});
	}

	async remove(id: number) {
		await this.findOne(id);

		await this.prisma.document.delete({
			where: { id },
		});

		return { deleted: true };
	}
}
