import { Module } from '@nestjs/common';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { M7Module } from 'src/rastreamento/m7/m7.module';
import { LogicaModule } from 'src/rastreamento/logica/logica.module';
import { SoftruckModule } from 'src/rastreamento/softruck/softruck.module';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { WebhookProcessor } from 'src/rastreamento/processors/webhook.processor';

/**
 * Orquestração de rastreamento: consulta os três provedores (M7, Lógica,
 * Softruck) em paralelo e escolhe a posição mais recente; recebe webhooks M7.
 * Cada provedor é um submódulo próprio com exports explícitos.
 */
@Module({
  imports: [NotificationsModule, M7Module, LogicaModule, SoftruckModule],
  controllers: [RastreamentoController],
  providers: [RastreamentoService, WebhookProcessor],
})
export class RastreamentoModule {}
