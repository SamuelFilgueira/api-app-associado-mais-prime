import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class SgaService {
  private readonly logger = new Logger(SgaService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Busca o CPF limpo (somente dígitos) de um usuário pelo ID
   */
  private async getUserCpf(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    return user.cpf.replace(/\D/g, '');
  }

  /**
   * Realiza chamada à API SGA da Hinova para buscar dados do associado
   */
  private async fetchSgaAssociado(cpf: string) {
    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;
    return axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.SGA_TOKEN}`,
      },
      validateStatus: () => true,
    });
  }

  async consultarAssociado(userId: number) {
    const cpf = await this.getUserCpf(userId);
    try {
      const response = await this.fetchSgaAssociado(cpf);
      if (response.status === 406) {
        return response.data;
      }
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
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
    const cpf = await this.getUserCpf(userId);
    try {
      const response = await this.fetchSgaAssociado(cpf);
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }

      // Persistência local dos veículos
      const veiculos = Array.isArray(response.data?.veiculos)
        ? response.data.veiculos
        : [];
      const now = new Date();
      const upsertedChassis = new Set<string>();

      // Upsert all vehicles
      for (const v of veiculos) {
        if (!v.chassi) continue; // skip invalid
        upsertedChassis.add(v.chassi);
        await this.prisma.userVehicle.upsert({
          where: {
            userId_chassi: {
              userId: userId,
              chassi: v.chassi,
            },
          },
          update: {
            plate: v.placa || null,
            externalVehicleCode: v.codigo_veiculo
              ? String(v.codigo_veiculo)
              : null,
            isActive: true,
            lastSyncAt: now,
          },
          create: {
            userId: userId,
            chassi: v.chassi,
            plate: v.placa || null,
            externalVehicleCode: v.codigo_veiculo
              ? String(v.codigo_veiculo)
              : null,
            isActive: true,
            lastSyncAt: now,
          },
        });
      }

      // Mark as inactive any vehicles not present in the latest sync
      await this.prisma.userVehicle.updateMany({
        where: {
          userId: userId,
          chassi: { notIn: Array.from(upsertedChassis) },
          isActive: true,
        },
        data: {
          isActive: false,
          lastSyncAt: now,
        },
      });

      // Retorna apenas o array de veículos (mantém resposta para frontend)
      return veiculos;
    } catch (error) {
      if (error.response && error.response.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException(
        'Erro ao consultar veículos do associado',
      );
    }
  }
}
