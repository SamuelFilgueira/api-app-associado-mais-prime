import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { SgaVeiculo } from 'src/sga/domain/veiculo-sga';

/**
 * Espelho local dos veículos do associado (`UserVehicle`), alinhado ao que
 * o SGA devolveu: grava/atualiza os que vieram e desativa os que sumiram.
 *
 * Quem chama garante que a lista é a de um 2xx válido — sincronizar com uma
 * lista vazia por engano desativa todos os veículos do usuário.
 */
@Injectable()
export class VeiculosSincronizacaoService {
  constructor(private readonly prisma: PrismaService) {}

  async sincronizar(
    userId: number,
    veiculos: SgaVeiculo[],
    agora: Date = new Date(),
  ): Promise<void> {
    const chassis = new Set<string>();

    for (const v of veiculos) {
      if (!v.chassi) continue; // sem chassi não há como identificar o veículo
      chassis.add(String(v.chassi));
      const dados = {
        plate: v.placa || null,
        externalVehicleCode: v.codigo_veiculo ? String(v.codigo_veiculo) : null,
        isActive: true,
        lastSyncAt: agora,
      };
      await this.prisma.userVehicle.upsert({
        where: { userId_chassi: { userId, chassi: v.chassi } },
        update: dados,
        create: { userId, chassi: v.chassi, ...dados },
      });
    }

    // Desativa os veículos que não vieram nesta sincronização.
    await this.prisma.userVehicle.updateMany({
      where: {
        userId,
        chassi: { notIn: Array.from(chassis) },
        isActive: true,
      },
      data: { isActive: false, lastSyncAt: agora },
    });
  }

  /** Marca (ou desmarca) a exigência de revistoria nos veículos do chassi. */
  async marcarRevistoria(
    chassi: string,
    reinspectionRequired: boolean,
  ): Promise<number> {
    const { count } = await this.prisma.userVehicle.updateMany({
      where: { chassi },
      data: { reinspectionRequired },
    });
    return count;
  }
}
