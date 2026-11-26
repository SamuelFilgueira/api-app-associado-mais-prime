import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ExpurgoService } from 'src/infra/manutencao/expurgo.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { MANUTENCAO_QUEUE } from 'src/queue/filas';
import { ProcessadorBase } from 'src/queue/processador-base';

export const JOB_EXPURGO = 'expurgo';
export const JOB_LIMPAR_PDF = 'limpar-troca-de-pdf';

/**
 * Rotinas periódicas de manutenção, registradas só no papel `worker`:
 *  - expurgo de retenção, todo dia às 03:30 (horário de Brasília);
 *  - limpeza do diretório de troca de PDF, a cada 10 minutos.
 */
@Processor(MANUTENCAO_QUEUE)
export class ManutencaoProcessor
  extends ProcessadorBase<Record<string, never>, unknown>
  implements OnApplicationBootstrap
{
  protected readonly logger = new Logger(ManutencaoProcessor.name);

  constructor(
    private readonly expurgo: ExpurgoService,
    private readonly trava: TravaService,
    @InjectQueue(MANUTENCAO_QUEUE) private readonly fila: Queue,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.fila.upsertJobScheduler(
        'manutencao-expurgo',
        { pattern: '30 3 * * *', tz: 'America/Sao_Paulo' },
        { name: JOB_EXPURGO, opts: { attempts: 1 } },
      );
      await this.fila.upsertJobScheduler(
        'manutencao-pdf',
        { every: 10 * 60_000 },
        { name: JOB_LIMPAR_PDF, opts: { attempts: 1 } },
      );
    } catch (erro) {
      this.logger.error(
        `Não foi possível agendar a manutenção: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  protected async executar(job: Job): Promise<unknown> {
    if (job.name === JOB_LIMPAR_PDF) {
      return { removidos: await this.expurgo.limparTrocaDePdf() };
    }
    if (job.name !== JOB_EXPURGO) return null;

    // Uma rodada por vez no deploy: um disparo manual não corre junto com o
    // agendado.
    const resultado = await this.trava.tentar(
      'manutencao:expurgo',
      30 * 60_000,
      () => this.expurgo.executar(),
    );
    if (!resultado.executou) {
      this.logger.warn(
        'Expurgo já em execução em outro processo; rodada ignorada.',
      );
      return null;
    }
    return resultado.valor;
  }
}
