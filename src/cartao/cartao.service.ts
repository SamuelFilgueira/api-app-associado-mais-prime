import { Injectable, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CartaoService {
  constructor(private prisma: PrismaService) {}

  async gerarCartaoVirtual(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.plate || !user.cpf) {
      throw new NotFoundException('Placa ou CPF não encontrados para o usuário');
    }
    const url = `https://tst-clubgas-api.azurewebsites.net/api/v1/CartaoClub/obter-virtual?Placa=${user.plate}&Cpf=${user.cpf}`;
    const { data } = await axios.get(url);
    return data;
  }
}
