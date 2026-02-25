import { Injectable, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class EconomiaService {
  constructor(private prisma: PrismaService) {}

  async consultarTotalEconomizado(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    const cpf = user.cpf.replace(/\D/g, '');
    const url = `https://clubgas-api.azurewebsites.net/api/v1/Aplicativo/total-economizado?CpfCnpj=${cpf}`;
    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.TOKEN_API_CLUBGAS}`,
      },
    });
    return data;
  }
}
