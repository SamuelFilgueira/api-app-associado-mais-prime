import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CartaoService {
  private readonly logger = new Logger(CartaoService.name);

  constructor(private prisma: PrismaService) {}

  async gerarCartaoVirtual(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }

    const vehicle = await this.prisma.userVehicle.findFirst({
      where: { userId, isActive: true, plate: { not: null } },
    });
    if (!vehicle?.plate) {
      throw new NotFoundException('Placa não encontrada para o usuário');
    }

    const url = `https://clubgas-api.azurewebsites.net/api/v1/CartaoClub/obter-virtual?Placa=${vehicle.plate}&Cpf=${user.cpf}`;
    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.TOKEN_API_CLUBGAS}`,
      },
    });
    this.logger.log(`Dados do cartão virtual obtidos para usuário: ${userId}`);
    return data;
  }
}
