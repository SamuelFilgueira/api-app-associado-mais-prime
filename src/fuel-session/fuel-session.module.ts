import { Module } from '@nestjs/common';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import { FuelEconomyProcessor } from 'src/fuel-session/processors/fuel-economy.processor';
import { EconomiaModule } from '../economia/economia.module';
import { NotificationsModule } from '../notifications/notifications.module';

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
  imports: [EconomiaModule, NotificationsModule],
  providers: [FuelSessionService, FuelEconomyProcessor],
  exports: [FuelSessionService],
})
export class FuelSessionModule {}
