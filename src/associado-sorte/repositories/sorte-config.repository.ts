import { Injectable } from '@nestjs/common';
import { Prisma, SorteConfig } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

/** Configuração da promoção: uma linha por base. */
@Injectable()
export class SorteConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  buscar(baseOrigin: string): Promise<SorteConfig | null> {
    return this.prisma.sorteConfig.findUnique({ where: { baseOrigin } });
  }

  salvar(
    baseOrigin: string,
    data: Omit<Prisma.SorteConfigUncheckedCreateInput, 'baseOrigin'>,
  ): Promise<SorteConfig> {
    return this.prisma.sorteConfig.upsert({
      where: { baseOrigin },
      create: { ...data, baseOrigin },
      update: data,
    });
  }
}
