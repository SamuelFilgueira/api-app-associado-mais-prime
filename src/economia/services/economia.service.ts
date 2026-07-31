import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';

@Injectable()
export class EconomiaService {
  constructor(
    private prisma: PrismaService,
    private readonly clubgasClient: ClubgasClient,
  ) {}

  async consultarTotalEconomizado(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    const cpf = user.cpf.replace(/\D/g, '');
    const data = await this.clubgasClient.obterTotalEconomizadoLegado(cpf);

    // Persistir o valor atual para que o gatilho de abastecimento
    // use a diferença real e não o total acumulado histórico.
    const novoValor = parseFloat(data?.totalEconomizado);
    if (!isNaN(novoValor) && novoValor > user.totalEconomizado) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { totalEconomizado: novoValor },
      });
    }

    return data;
  }
}
