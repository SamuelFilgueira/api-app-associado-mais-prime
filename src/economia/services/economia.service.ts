import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import {
  ClubgasErroLogService,
  ClubgasErroOrigem,
} from 'src/integrations/clubgas/clubgas-erro-log.service';

@Injectable()
export class EconomiaService {
  constructor(
    private prisma: PrismaService,
    private readonly clubgasClient: ClubgasClient,
    private readonly clubgasErros: ClubgasErroLogService,
  ) {}

  /**
   * `origem` identifica no `ClubgasErroLog` se a consulta partiu do app ou do
   * job de verificação pós-abastecimento (`FuelEconomyProcessor`).
   */
  async consultarTotalEconomizado(
    userId: number,
    origem: ClubgasErroOrigem = 'APP',
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    const cpf = user.cpf.replace(/\D/g, '');

    let data: Awaited<ReturnType<ClubgasClient['obterTotalEconomizadoLegado']>>;
    try {
      data = await this.clubgasClient.obterTotalEconomizadoLegado(cpf);
    } catch (falha) {
      // Grava em ClubgasErroLog e devolve a resposta HTTP equivalente.
      throw await this.clubgasErros.tratar(falha, {
        userId,
        baseOrigin: user.baseOrigin,
        origem,
        documento: cpf,
      });
    }

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
