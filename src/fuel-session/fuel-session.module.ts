import { Module } from '@nestjs/common';
import { FuelSessionService } from './fuel-session.service';
import { FuelEconomyProcessor } from './fuel-economy.processor';
import { EconomiaService } from '../economia/economia.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma.service';

/**
 * Módulo responsável pelo rastreamento de economia de combustível.
 *
 * Fluxo:
 *   1. CartaoService cria uma FuelSession e enfileira um job com 5min de delay
 *   2. FuelEconomyProcessor processa o job consultando a API externa
 *   3. Se houve abastecimento, completa a sessão e envia push notification
 *
 * Depende do QueueModule (global) para acesso à fila FUEL_ECONOMY_QUEUE.
 */
@Module({
  imports: [NotificationsModule],
  providers: [
    FuelSessionService,
    FuelEconomyProcessor,
    EconomiaService,
    PrismaService,
  ],
  exports: [FuelSessionService],
})
export class FuelSessionModule {}
