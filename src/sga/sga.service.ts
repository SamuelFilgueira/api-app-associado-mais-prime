import { Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class SgaService {
  constructor(private prisma: PrismaService) {}


  async consultarAssociado(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    const cpf = user.cpf.replace(/\D/g, '');
    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.SGA_TOKEN}`,
        },
        validateStatus: () => true // Aceita qualquer status
      });
      if (response.status === 406) {
        return response.data;
      }
      if (response.status >= 400) {
        return response.data || { mensagem: 'Erro desconhecido', error: [response.statusText] };
      }
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException('Erro ao consultar SGA');
    }
  }

  async consultarVeiculosAssociado(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    const cpf = user.cpf.replace(/\D/g, '');
    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.SGA_TOKEN}`,
        },
        validateStatus: () => true
      });
      if (response.status >= 400) {
        return response.data || { mensagem: 'Erro desconhecido', error: [response.statusText] };
      }
      // Retorna apenas o array de veículos
      return response.data && response.data.veiculos ? response.data.veiculos : [];
    } catch (error) {
      if (error.response && error.response.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException('Erro ao consultar veículos do associado');
    }
  }
}
