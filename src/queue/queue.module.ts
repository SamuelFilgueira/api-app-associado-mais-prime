import { Global, Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PapelDeProcesso, papelAtivo } from 'src/config/app.config';
import { redisConnectionOptions } from 'src/config/redis.config';
import { FilasAdminController } from 'src/queue/controllers/filas-admin.controller';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { FILAS, FILA_DE_MORTOS, OPCOES_POR_FILA } from 'src/queue/filas';
import { FilasMetricasService } from 'src/queue/filas-metricas.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';

// Os nomes das filas vivem em `filas.ts`; reexportados aqui porque é deste
// módulo que o restante do código sempre os importou.
export * from 'src/queue/filas';

/**
 * Devolve os providers só quando o processo exerce o papel informado.
 *
 * É assim que os processors e os agendadores ficam restritos ao papel
 * `worker` (ou `pdf`): no papel `api`, o módulo de feature simplesmente não
 * os registra, e a API só produz jobs.
 *
 *   providers: [BoletoService, ...paraPapel('worker', [BoletoProcessor])]
 */
export function paraPapel(
  papel: PapelDeProcesso,
  providers: Provider[],
): Provider[] {
  return papelAtivo(papel) ? providers : [];
}

/**
 * Módulo global das filas (BullMQ sobre Redis).
 *
 * A conexão vem de `src/config/redis.config.ts` (REDIS_HOST, REDIS_PORT,
 * REDIS_PASSWORD, REDIS_USERNAME, REDIS_DB). Em Docker, REDIS_HOST deve
 * apontar para o nome do serviço do container Redis (ex.: "redis"), nunca
 * "localhost".
 *
 * As opções padrão de cada fila (retry e retenção) ficam em `filas.ts`.
 */
@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions() }),

    // Registra as filas que serão injetadas pela aplicação
    BullModule.registerQueue(
      ...FILAS.map((name) => ({
        name,
        defaultJobOptions: OPCOES_POR_FILA[name],
      })),
      // Jobs mortos ficam até alguém reprocessar ou descartar.
      {
        name: FILA_DE_MORTOS,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
      },
    ),
  ],
  controllers: [FilasAdminController],
  providers: [FilaDeMortosService, ProdutorDeFilas, FilasMetricasService],
  exports: [BullModule, FilaDeMortosService, ProdutorDeFilas],
})
export class QueueModule {}
