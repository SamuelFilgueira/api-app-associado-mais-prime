import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import {
  deveAtualizarTotalGravado,
  interpretarTotalEconomizado,
} from 'src/economia/domain/total-economizado';
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

    // Mantém o total do cadastro em dia com o Clubgas (é o que o app mostra
    // sem consultar). O valor de partida da verificação de abastecimento NÃO
    // sai daqui: é lido do Clubgas na hora em que o cartão é aberto.
    const novoValor = interpretarTotalEconomizado(data?.totalEconomizado);
    if (deveAtualizarTotalGravado(novoValor, user.totalEconomizado)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { totalEconomizado: novoValor },
      });
    }

    return data;
  }
}
