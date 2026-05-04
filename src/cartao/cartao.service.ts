import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import axios from 'axios';
import { PrismaService } from '../prisma.service';
import { FuelSessionService } from '../fuel-session/fuel-session.service';
import { FUEL_ECONOMY_QUEUE } from '../queue/queue.module';

@Injectable()
export class CartaoService {
  private readonly logger = new Logger(CartaoService.name);

  constructor(
    private prisma: PrismaService,
    private readonly fuelSessionService: FuelSessionService,
    @InjectQueue(FUEL_ECONOMY_QUEUE) private readonly fuelEconomyQueue: Queue,
  ) {}

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

    // Disparar verificação de economia em background (não bloqueia o fluxo)
    void this.triggerFuelEconomyCheck(userId);

    return data;
  }

  /**
   * Cria uma FuelSession PENDING e enfileira um job com delay de 5 minutos
   * para verificar se houve abastecimento após a consulta do cartão virtual.
   *
   * Erros aqui NÃO propagam — a resposta do cartão não é afetada.
   */
  /** TODO: remover após testes */
  async testFuelEconomyCheck(userId: number) {
    // Expira qualquer sessão PENDING anterior para não bloquear o teste
    await this.prisma.fuelSession.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });

    const session = await this.fuelSessionService.createPendingSession(userId, 0);

    const job = await this.fuelEconomyQueue.add(
      'check-fuel-economy',
      { fuelSessionId: session.id },
      { delay: 0, attempts: 1 },
    );

    this.logger.log(
      `[FUEL TEST] SessionId=${session.id} jobId=${job.id} para user ${userId}`,
    );

    return { sessionId: session.id, jobId: job.id };
  }

  private async triggerFuelEconomyCheck(userId: number): Promise<void> {
    try {
      // Evitar múltiplas sessions PENDING simultâneas para o mesmo usuário
      const existing = await this.fuelSessionService.findPendingForUser(userId);
      if (existing) {
        this.logger.log(
          `[FUEL] user ${userId} já possui FuelSession PENDING (${existing.id}) — ignorando nova criação`,
        );
        return;
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { totalEconomizado: true },
      });

      const valorAntes = user?.totalEconomizado ?? 0;

      const session = await this.fuelSessionService.createPendingSession(
        userId,
        valorAntes,
      );

      const job = await this.fuelEconomyQueue.add(
        'check-fuel-economy',
        { fuelSessionId: session.id },
        {
          delay: 5 * 60 * 1000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );

      this.logger.log(
        `[FUEL] FuelSession ${session.id} criada para user ${userId} (valorAntes=${valorAntes}) — job #${job.id} enfileirado com delay de 5min`,
      );
    } catch (error) {
      this.logger.error(
        `[FUEL] Erro ao disparar verificação de economia para user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
