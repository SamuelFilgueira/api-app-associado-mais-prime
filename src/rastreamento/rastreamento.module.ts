import { Module } from '@nestjs/common';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { M7Module } from 'src/rastreamento/m7/m7.module';
import { LogicaModule } from 'src/rastreamento/logica/logica.module';
import { SoftruckModule } from 'src/rastreamento/softruck/softruck.module';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { ConsultarPosicaoService } from 'src/rastreamento/services/consultar-posicao.service';
import { ComandosVeiculoService } from 'src/rastreamento/services/comandos-veiculo.service';
import { ProcessarWebhookM7Service } from 'src/rastreamento/services/processar-webhook-m7.service';
import { ConsultasPorProvedorService } from 'src/rastreamento/services/consultas-por-provedor.service';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import { EventoWebhookRepository } from 'src/rastreamento/repositories/evento-webhook.repository';
import { WebhookProcessor } from 'src/rastreamento/processors/webhook.processor';
import {
  PROVEDORES_DE_RASTREAMENTO,
  ProvedorDeRastreamento,
} from 'src/rastreamento/providers/rastreamento-provider.interface';
import { ProvedorM7 } from 'src/rastreamento/m7/services/m7-provedor';
import { ProvedorLogica } from 'src/rastreamento/logica/services/logica-provedor';
import { ProvedorSoftruck } from 'src/rastreamento/softruck/services/softruck-provedor';
import { paraPapel } from 'src/queue/queue.module';

/**
 * Orquestração de rastreamento: posição unificada, comandos de veículo e
 * webhook da M7. Cada provedor é um submódulo próprio com exports explícitos.
 *
 * REGISTRO DE PROVEDORES: a lista abaixo é o único lugar que enumera os
 * provedores de posição. A ordem é a de desempate quando duas posições têm o
 * mesmo instante. Provedor novo entra aqui (e no `imports`) — o orquestrador
 * (`ConsultarPosicaoService`) não muda.
 */
@Module({
  imports: [NotificationsModule, M7Module, LogicaModule, SoftruckModule],
  controllers: [RastreamentoController],
  providers: [
    {
      provide: PROVEDORES_DE_RASTREAMENTO,
      useFactory: (
        ...provedores: ProvedorDeRastreamento[]
      ): ProvedorDeRastreamento[] => provedores,
      inject: [ProvedorLogica, ProvedorM7, ProvedorSoftruck],
    },
    VeiculoRastreamentoRepository,
    EventoWebhookRepository,
    ConsultarPosicaoService,
    ComandosVeiculoService,
    ProcessarWebhookM7Service,
    ConsultasPorProvedorService,
    RastreamentoService,
    ...paraPapel('worker', [WebhookProcessor]),
  ],
})
export class RastreamentoModule {}
