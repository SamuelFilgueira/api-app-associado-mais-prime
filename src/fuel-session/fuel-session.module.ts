import { Module } from '@nestjs/common';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import { VerificacaoDeEconomiaService } from 'src/fuel-session/services/verificacao-de-economia.service';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';
import { FuelEconomyProcessor } from 'src/fuel-session/processors/fuel-economy.processor';
import { EconomiaModule } from '../economia/economia.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { paraPapel } from 'src/queue/queue.module';

/**
 * Módulo responsável pelo rastreamento de economia de combustível.
 *
 * Fluxo:
 *   1. `FuelSessionService.abrirSessao` (chamado pelo cartão virtual) lê o
 *      total economizado no Clubgas, cria a sessão PENDING — uma por usuário —
 *      e enfileira a primeira checagem para dali a 5 minutos
 *   2. `FuelEconomyProcessor` delega cada checagem a
 *      `VerificacaoDeEconomiaService`: houve abastecimento → conclui a sessão
 *      e envia o push; sem variação → agenda a próxima checagem; no teto de
 *      checagens → expira a sessão
 *
 * Depende do QueueModule (global) para acesso à fila FUEL_ECONOMY_QUEUE.
 */
@Module({
  imports: [EconomiaModule, NotificationsModule],
  providers: [
    FuelSessionRepository,
    FuelSessionService,
    VerificacaoDeEconomiaService,
    ...paraPapel('worker', [FuelEconomyProcessor]),
  ],
  exports: [FuelSessionService],
})
export class FuelSessionModule {}
