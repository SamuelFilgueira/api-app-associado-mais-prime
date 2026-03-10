import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { CreateSliderDto } from './DTOs/create-slider.dto';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { UpdateSliderDto } from './DTOs/update-slider.dto';

@Injectable()
export class SliderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  async getSliders(isActive?: boolean) {
    return this.prisma.sliderInfo.findMany({
      where:
        typeof isActive === 'boolean'
          ? {
              isActive,
            }
          : undefined,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createSlider(
    createSliderDto: CreateSliderDto,
    image?: Express.Multer.File,
  ) {
    const {
      title,
      subtitle,
      description,
      imageUrl: fallbackImageUrl,
      whatsapp,
      linkUrl,
      isActive,
    } = createSliderDto;

    const uploadedImageUrl = image
      ? await this.fileUploadService.uploadSliderPhoto(image)
      : null;

    const imageUrl = uploadedImageUrl || fallbackImageUrl;

    if (!imageUrl) {
      throw new BadRequestException('A imagem do slider é obrigatória');
    }

    const slider = await this.prisma.sliderInfo.create({
      data: {
        title,
        subtitle,
        description,
        imageUrl,
        whatsapp,
        linkUrl,
        isActive,
      },
    });

    return slider;
  }

  async updateSlider(
    id: number,
    updateSliderDto: UpdateSliderDto,
    image?: Express.Multer.File,
  ) {
    const existing = await this.prisma.sliderInfo.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Slider não encontrado');
    }

    let uploadedImageUrl: string | undefined;
    if (image) {
      uploadedImageUrl = await this.fileUploadService.uploadSliderPhoto(image);
      const currentImageUrl = existing.imageUrl;
      if (typeof currentImageUrl === 'string' && currentImageUrl) {
        await this.fileUploadService.deleteSliderPhoto(currentImageUrl);
      }
    }

    return this.prisma.sliderInfo.update({
      where: { id },
      data: {
        ...updateSliderDto,
        imageUrl: uploadedImageUrl || updateSliderDto.imageUrl,
      },
    });
  }

  async deleteSlider(id: number) {
    const existing = await this.prisma.sliderInfo.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Slider não encontrado');
    }

    await this.prisma.sliderInfo.delete({ where: { id } });

    const currentImageUrl = existing.imageUrl;
    if (typeof currentImageUrl === 'string' && currentImageUrl) {
      await this.fileUploadService.deleteSliderPhoto(currentImageUrl);
    }

    return { message: 'Slider removido com sucesso' };
  }
}
