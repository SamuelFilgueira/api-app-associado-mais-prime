import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { CreateDocumentDto } from 'src/documentos/dto/create-document.dto';
import { UpdateDocumentDto } from 'src/documentos/dto/update-document.dto';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { TENANT } from 'src/config/tenant.config';

@Injectable()
export class DocumentosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  /**
   * URL base pública usada para montar os links de documentos.
   * Vem de `TENANT_DOCUMENTS_BASE_URL` ou `APP_URL`; se nenhuma estiver
   * configurada, mantém o valor histórico para não quebrar deploys atuais.
   */
  private readonly urlBase = TENANT.documentsBaseUrl;

  private buildDocumentUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }

    const normalizedBase = this.urlBase.replace(/\/+$/, '');
    const normalizedPath = url.startsWith('/') ? url : `/${url}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  uploadDocument(file: Express.Multer.File): Promise<string> {
    if (!file) {
      throw new BadRequestException('Arquivo do documento é obrigatório');
    }

    return this.fileUploadService.uploadDocumentFile(file);
  }

  async create(data: CreateDocumentDto, file?: Express.Multer.File) {
    const uploadedPath = file ? await this.uploadDocument(file) : null;
    const documentUrl = uploadedPath ?? data.documentUrl;

    if (!documentUrl) {
      throw new BadRequestException(
        'Arquivo do documento é obrigatório quando documentUrl não for informado',
      );
    }

    return this.prisma.document.create({
      data: {
        ...data,
        documentUrl,
      },
    });
  }

  async findAll() {
    const documents = await this.prisma.document.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return documents.map((document) => ({
      ...document,
      documentUrl: this.buildDocumentUrl(document.documentUrl),
    }));
  }

  async getTotalDocuments() {
    const totalDocumentos = await this.prisma.document.count();

    return {
      totalDocumentos,
    };
  }

  async findOne(id: number) {
    const document = await this.prisma.document.findUnique({
      where: { id },
    });

    if (!document) {
      throw new NotFoundException('Documento nao encontrado');
    }

    return {
      ...document,
      documentUrl: this.buildDocumentUrl(document.documentUrl),
    };
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
