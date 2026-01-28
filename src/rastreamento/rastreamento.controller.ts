import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { RastreamentoService } from './rastreamento.service';
import { M7WebhookGuard } from './guards/m7.guard';

@Controller('rastreamento')
export class RastreamentoController {
  constructor(private readonly rastreamentoService: RastreamentoService) {}

  // ROTAS REFERENTES AO RASTREAMENTO M7
  @Post('renovar-token')
  async renovarToken() {
    return this.rastreamentoService.renovarTokenM7();
  }

  @Post('ultima-posicao')
  async ultimaPosicaoM7(@Body() body: { cnpj: string; chassi: string }) {
    console.log('Body recebido para ultimaPosicao:', body);
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
    console.log('[Rastreamento Controller] Webhook M7 recebido');
    return this.rastreamentoService.processarWebhookM7(payload);
  }
}
