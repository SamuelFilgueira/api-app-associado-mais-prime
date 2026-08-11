import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Logger,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { M7WebhookGuard } from 'src/rastreamento/guards/m7.guard';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { BaseContextService } from 'src/shared/base-context.service';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { HistoricoQueryDto } from 'src/rastreamento/softruck/dto/historico-query.dto';

interface RastreamentoRequestContext {
  baseOrigin: BaseOrigin;
  logicaToken: string;
  logicaTokenKey: string;
  softruckPublicKey: string;
}

@Controller('rastreamento')
export class RastreamentoController {
  private readonly logger = new Logger(RastreamentoController.name);

  constructor(
    private readonly rastreamentoService: RastreamentoService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    private readonly baseContextService: BaseContextService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  private buildRastreamentoContext(): RastreamentoRequestContext {
    const baseOrigin = this.baseContextService.getBaseOrigin();
    const logicaTokenKey = this.tokenResolver.getTokenKey(baseOrigin, 'logica');

    return {
      baseOrigin,
      logicaToken: this.tokenResolver.resolveLogicaToken(baseOrigin),
      logicaTokenKey,
      softruckPublicKey:
        this.tokenResolver.resolveSoftruckPublicKey(baseOrigin),
    };
  }

  //ROTA PRINCIPAL DE RASTREAMENTO UNIFICADO (SOFTRUCK + M7 + LÓGICA SOLUÇÕES)
  @UseGuards(JwtAuthGuard)
  @Post()
  rastreamento(@Body() body: { cnpj: string; chassi: string }) {
    const ctx = this.buildRastreamentoContext();

    return this.rastreamentoService.rastreamento(body.cnpj, body.chassi, {
      baseOrigin: ctx.baseOrigin,
      logicaToken: ctx.logicaToken,
      logicaTokenKey: ctx.logicaTokenKey,
      softruckPublicKey: ctx.softruckPublicKey,
    });
  }

  @Post('renovar-token')
  async renovarToken() {
    return this.rastreamentoService.renovarTokenM7();
  }

  @UseGuards(JwtAuthGuard)
  @Post('ultima-posicao')
  async ultimaPosicaoM7(@Body() body: { cnpj: string; chassi: string }) {
    const ctx = this.buildRastreamentoContext();
    return this.rastreamentoService.ultimaPosicaoM7(
      body.cnpj,
      body.chassi,
      ctx.baseOrigin,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('historico/softruck/pdf')
  async gerarRelatorioHistoricoSoftruckPDF(
    @Query() query: HistoricoQueryDto,
    @Res() res: Response,
  ) {
    const ctx = this.buildRastreamentoContext();

    const pdfBuffer = await this.rastreamentoService.gerarRelatorioHistoricoSoftruckPDF(
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      ctx.baseOrigin,
      ctx.softruckPublicKey,
    );

    const safeChassi = query.chassi.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    const fileName = `trajetorias-${safeChassi}-${query.dataInicial}-${query.dataFinal}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  }

  @UseGuards(JwtAuthGuard)
  @Get('historico/softruck/rotas')
  async obterRotasHistoricoSoftruck(@Query() query: HistoricoQueryDto) {
    const ctx = this.buildRastreamentoContext();

    return this.rastreamentoService.obterRotasHistoricoSoftruck(
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      ctx.baseOrigin,
      ctx.softruckPublicKey,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('ancora-m7')
  async ancoraM7(
    @Body() body: { cnpj: string; chassi: string; ancora_ativa: boolean },
  ) {
    const ctx = this.buildRastreamentoContext();
    return this.rastreamentoService.ancoraM7(
      body.cnpj,
      body.chassi,
      body.ancora_ativa,
      ctx.baseOrigin,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('ignicao-m7')
  ignicaoM7(@Body() body: { cnpj: string; chassi: string; evt_ign: boolean }) {
    const ctx = this.buildRastreamentoContext();
    return this.rastreamentoService.ignicaoM7(
      body.cnpj,
      body.chassi,
      body.evt_ign,
      ctx.baseOrigin,
    );
  }

  @Get('ignicao-status')
  async getIgnicaoStatus(@Query('chassi') chassi: string) {
    return this.rastreamentoService.getIgnicaoStatus(chassi);
  }

  @Get('ancora-status')
  async getAncoraStatus(@Query('chassi') chassi: string) {
    return this.rastreamentoService.getAncoraStatus(chassi);
  }

  // ROTAS REFERENTES AO RASTREAMENTO LÓGICA SOLUÇÕES

  @UseGuards(JwtAuthGuard)
  @Post('ultima-posicao-logica')
  async ultimaPosicaoLogica(@Body() body: { chassi: string }) {
    const ctx = this.buildRastreamentoContext();

    return this.rastreamentoService.ultimaPosicaoLogica(
      body.chassi,
      ctx.logicaToken,
      {
        baseOrigin: ctx.baseOrigin,
        tokenKey: ctx.logicaTokenKey,
      },
    );
  }

  // ROTAS REFERENTES AO RASTREAMENTO SOFTRUCK

  @UseGuards(JwtAuthGuard)
  @Post('ultima-posicao-softruck')
  async ultimaPosicaoSoftruck(@Body() body: { chassi: string }) {
    const ctx = this.buildRastreamentoContext();

    return this.rastreamentoService.ultimaPosicaoSoftruck(
      body.chassi,
      ctx.baseOrigin,
      ctx.softruckPublicKey,
    );
  }

  //WEBHOOKS

  // Webhook M7 para eventos de rastreamento
  @UseGuards(M7WebhookGuard)
  @Post('webhook-m7')
  async webhookM7(@Body() payload: unknown) {
    const job = await this.webhookQueue.add(
      'm7-event',
      { payload },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    return { queued: true, jobId: job.id };
  }
}
