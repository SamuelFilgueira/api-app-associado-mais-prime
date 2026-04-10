import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CartaoService {
  private readonly logger = new Logger(CartaoService.name);

  constructor(private prisma: PrismaService) {}

  private maskSecret(value?: string): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  async gerarCartaoVirtual(
    userId: number,
    chassi: string,
    clubgasToken: string,
    baseOrigin?: string,
    clubgasTokenKey?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }

    const vehicle = await this.prisma.userVehicle.findFirst({
      where: {
        userId,
        chassi,
        isActive: true,
      },
    });
    if (!vehicle?.plate) {
      throw new NotFoundException('Placa não encontrada para o usuário');
    }

    const url = `https://clubgas-api.azurewebsites.net/api/v1/CartaoClub/obter-virtual?Placa=${vehicle.plate}&Cpf=${user.cpf}`;
    this.logger.log(
      `[${baseOrigin ?? 'DESCONHECIDA'}] ClubGas cartão usando tokenKey=${clubgasTokenKey ?? '(não informado)'} token=${this.maskSecret(clubgasToken)}`,
    );
    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${clubgasToken}`,
      },
    });
    this.logger.log(`Dados do cartão virtual obtidos para usuário: ${userId}`);
    return data;
  }
}
