import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

export interface DadosDoPopup {
  imageUrl?: string;
  linkUrl?: string;
  linkLabel?: string;
  active?: boolean;
}

/** Pop-up da tela inicial do app, controlado pelo painel. */
@Injectable()
export class PopupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  /** O pop-up exibido no app: o mais recente com `active`. */
  ativo() {
    return this.prisma.notificationPopup.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cria (sem `id`) ou atualiza o pop-up. Sem imagem nova o pop-up não pode
   * ser ativado por esta chamada; na criação a imagem é obrigatória.
   */
  async gravar(
    id: number | undefined,
    data: DadosDoPopup,
    userId: number,
    image?: Express.Multer.File,
  ) {
    let imageUrl = data.imageUrl;
    if (image) {
      const caminho = await this.fileUploadService.uploadPopupPhoto(image);
      imageUrl = this.fileUploadService.buildUrl(caminho) ?? undefined;
    }

    const dados: Prisma.NotificationPopupUncheckedUpdateInput = {
      linkUrl: data.linkUrl,
      linkLabel: data.linkLabel,
      active: data.active,
      userId,
    };
    if (imageUrl) dados.imageUrl = imageUrl;
    if (!imageUrl && dados.active) dados.active = false;

    if (!imageUrl && !id) {
      throw new BadRequestException('A imagem do pop-up é obrigatória');
    }

    if (id) {
      const existente = await this.prisma.notificationPopup.findUnique({
        where: { id },
      });
      if (!existente) throw new NotFoundException('Popup não encontrado');
      return this.prisma.notificationPopup.update({
        where: { id },
        data: dados,
      });
    }

    return this.prisma.notificationPopup.create({
      data: dados as Prisma.NotificationPopupUncheckedCreateInput,
    });
  }
}
