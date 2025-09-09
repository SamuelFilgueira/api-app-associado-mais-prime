import { Injectable, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class PostosService {
  constructor(private prisma: PrismaService) {}

  async buscarPostos(latitude: number, longitude: number, userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.plate) {
      throw new NotFoundException('Placa não encontrada para o usuário');
    }
    const url = `https://tst-clubgas-api.azurewebsites.net/api/v1/Posto/obter-map-app?Latitude=${latitude}&Longitude=${longitude}&Placa=${user.plate}`;
    const { data } = await axios.get(url);
    return data;
  }
}
