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

  /** Grava só os campos informados (a linha da base precisa existir ou é criada com os padrões). */
  atualizarParcial(
    baseOrigin: string,
    data: Prisma.SorteConfigUncheckedUpdateInput,
  ): Promise<SorteConfig> {
    return this.prisma.sorteConfig.upsert({
      where: { baseOrigin },
      create: {
        ...(data as Prisma.SorteConfigUncheckedCreateInput),
        baseOrigin,
      },
      update: data,
    });
  }
}
