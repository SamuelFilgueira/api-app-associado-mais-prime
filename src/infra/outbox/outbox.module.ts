import { Global, Module } from '@nestjs/common';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { OutboxProcessor } from 'src/infra/outbox/outbox.processor';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { ExpurgoService } from 'src/infra/manutencao/expurgo.service';
import { ManutencaoProcessor } from 'src/infra/manutencao/manutencao.processor';
import { paraPapel } from 'src/queue/queue.module';

/**
 * Peças de consistência usadas pelos módulos de domínio: outbox (banco e
 * fila juntos), idempotência por chave e trava distribuída. No papel
 * `worker` sobem também o despachante do outbox e a manutenção (expurgos).
 */
@Global()
@Module({
  providers: [
    OutboxService,
    IdempotenciaService,
    TravaService,
    ExpurgoService,
    ...paraPapel('worker', [OutboxProcessor, ManutencaoProcessor]),
  ],
  exports: [OutboxService, IdempotenciaService, TravaService, ExpurgoService],
})
export class ConsistenciaModule {}
