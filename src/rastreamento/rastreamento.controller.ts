import { Controller, Post, Body, UseGuards, Logger } from '@nestjs/common';
import { RastreamentoService } from './rastreamento.service';
import { M7WebhookGuard } from './guards/m7.guard';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WEBHOOK_QUEUE } from '../queue/queue.module';

@Controller('rastreamento')
export class RastreamentoController {
  private readonly logger = new Logger(RastreamentoController.name);

  constructor(
    private readonly rastreamentoService: RastreamentoService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
  ) {}

  // ROTAS REFERENTES AO RASTREAMENTO M7
  @Post('renovar-token')
  async renovarToken() {
    return this.rastreamentoService.renovarTokenM7();
  }

  @Post('ultima-posicao')
  async ultimaPosicaoM7(@Body() body: { cnpj: string; chassi: string }) {
    this.logger.log(`Body recebido para ultimaPosicao: ${JSON.stringify(body)}`);
    return this.rastreamentoService.ultimaPosicaoM7(body.cnpj, body.chassi);
  }

  @Post('ancora-m7')
  async ancoraM7(
    @Body() body: { cnpj: string; chassi: string; ancora_ativa: boolean },
  ) {
    return this.rastreamentoService.ancoraM7(
      body.cnpj,
      body.chassi,
      body.ancora_ativa,
    );
  }

  // ROTAS REFERENTES AO RASTREAMENTO LÓGICA SOLUÇÕES

  @Post('ultima-posicao-logica')
  async ultimaPosicaoLogica(@Body() body: { chassi: string }) {
    return this.rastreamentoService.ultimaPosicaoLogica(body.chassi);
  }

  // ROTAS REFERENTES AO RASTREAMENTO SOFTRUCK

  @Post('ultima-posicao-softruck')
  async ultimaPosicaoSoftruck(@Body() body: { chassi: string }) {
    return this.rastreamentoService.ultimaPosicaoSoftruck(body.chassi);
  }

  //WEBHOOKS

  // Webhook M7 para eventos de rastreamento
  @UseGuards(M7WebhookGuard)
  @Post('webhook-m7')
  async webhookM7(@Body() payload: unknown) {
    this.logger.log('Webhook M7 recebido — enfileirando para processamento');
    const job = await this.webhookQueue.add('m7-event', { payload }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    return { queued: true, jobId: job.id };
  }
}
