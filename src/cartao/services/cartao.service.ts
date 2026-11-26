import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { ClubgasErro } from 'src/integrations/clubgas/clubgas.erro';
import {
  ClubgasErroContexto,
  ClubgasErroLogService,
} from 'src/integrations/clubgas/clubgas-erro-log.service';
import { BaseOrigin } from 'src/config/tenant.config';
import { baseTag } from 'src/shared/log.util';

@Injectable()
export class CartaoService {
  private readonly logger = new Logger(CartaoService.name);

  constructor(
    private prisma: PrismaService,
    private readonly fuelSessionService: FuelSessionService,
    private readonly clubgasClient: ClubgasClient,
    private readonly clubgasErros: ClubgasErroLogService,
  ) {}

  async gerarCartaoVirtual(
    userId: number,
    chassi: string,
    baseOrigin: BaseOrigin,
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
    // O Clubgas só aceita o documento com dígitos (sem máscara nem espaços).
    const documento = user.cpf.replace(/\D/g, '');
    const contexto: ClubgasErroContexto = {
      userId,
      baseOrigin,
      chassi,
      placa: vehicle?.plate ?? null,
      documento,
    };

    if (!vehicle?.plate) {
      throw await this.clubgasErros.tratar(
        new ClubgasErro({
          operacao: 'CARTAO_VIRTUAL',
          categoria: 'VEICULO_SEM_PLACA',
          mensagem: 'Placa não encontrada para o usuário',
        }),
        contexto,
      );
    }

    let data: unknown;
    try {
      data = await this.clubgasClient.obterCartaoVirtual(baseOrigin, {
        placa: vehicle.plate,
        cpf: documento,
      });
    } catch (falha) {
      // Grava em ClubgasErroLog e devolve ao app a mensagem do Clubgas.
      throw await this.clubgasErros.tratar(falha, contexto);
    }

    // Verificação de economia em segundo plano: a resposta do cartão não
    // espera por ela nem depende dela.
    void this.abrirVerificacaoDeEconomia(userId, baseOrigin);

    return data;
  }

  /**
   * Abre a sessão de verificação de economia (`FuelSessionService`), que lê o
   * total economizado no Clubgas, cria a sessão pendente do usuário e agenda
   * a primeira checagem para dali a 5 minutos.
   *
   * Roda solta, depois de o cartão já ter sido obtido: falha aqui (Clubgas
   * fora na leitura do total — já gravada em `ClubgasErroLog` —, banco ou
   * fila) fica sem sessão e NÃO chega à resposta do cartão.
   */
  private async abrirVerificacaoDeEconomia(
    userId: number,
    baseOrigin: BaseOrigin,
  ): Promise<void> {
    try {
      await this.fuelSessionService.abrirSessao(userId, baseOrigin);
    } catch (error) {
      this.logger.error(
        `${baseTag(baseOrigin)} [FUEL] Verificação de economia não aberta para user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
