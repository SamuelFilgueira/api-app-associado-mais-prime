import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { M7WebhookGuard } from 'src/rastreamento/guards/m7.guard';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';
import {
  UsuarioAutenticado,
  ehTokenDoPainel,
} from 'src/infra/auth/usuario-autenticado';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { AdminTokenGuard } from 'src/infra/guards/admin-token.guard';
import { HistoricoQueryDto } from 'src/rastreamento/softruck/dto/historico-query.dto';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import {
  extrairEventoM7,
  idDoJobDoEventoM7,
} from 'src/rastreamento/domain/evento-m7';
import { AutorDoComando } from 'src/rastreamento/services/comandos-veiculo.service';
import { JOB_EVENTO_M7 } from 'src/rastreamento/services/processar-webhook-m7.service';

/**
 * Associado que fez a chamada. Serve para preferir o vínculo dele com o
 * chassi e para a auditoria do comando — NÃO para recusar: o rastreamento
 * não checa posse do veículo. Token do painel não identifica um associado.
 */
function autorDaRequisicao(req: Request): AutorDoComando {
  const user = (req as Request & { user?: UsuarioAutenticado }).user;
  const id = Number(user?.userId);
  const idValido = Number.isInteger(id) ? id : null;
  return ehTokenDoPainel(user)
    ? { userId: null, painelUserId: idValido }
    : { userId: idValido };
}

/**
 * Rotas de rastreamento. O controller só monta o contexto (base e autor) e
 * delega: nenhuma credencial de provedor é resolvida aqui — cada provedor
 * resolve a própria quando é chamado, então uma base sem Lógica ou sem
 * Softruck continua atendendo as rotas da M7.
 */
@Controller('rastreamento')
export class RastreamentoController {
  constructor(
    private readonly rastreamentoService: RastreamentoService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
  ) {}

  //ROTA PRINCIPAL DE RASTREAMENTO UNIFICADO (SOFTRUCK + M7 + LÓGICA SOLUÇÕES)
  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('posicao')
  @Post()
  rastreamento(
    @Body() body: { cnpj: string; chassi: string },
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    return this.rastreamentoService.rastreamento(body.cnpj, body.chassi, {
      baseOrigin,
    });
  }

  /**
   * Força a renovação do token M7 de todas as bases. Rota operacional: exige
   * o header `x-admin-token` e devolve só o resultado e a validade — o token
   * do vendor nunca sai da API.
   */
  @UseGuards(AdminTokenGuard)
  @Post('renovar-token')
  async renovarToken() {
    return this.rastreamentoService.renovarTokenM7();
  }

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('posicao')
  @Post('ultima-posicao')
  async ultimaPosicaoM7(
    @Body() body: { cnpj: string; chassi: string },
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    return this.rastreamentoService.ultimaPosicaoM7(
      body.cnpj,
      body.chassi,
      baseOrigin,
    );
  }

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('relatorio')
  @Get('historico/softruck/pdf')
  async gerarRelatorioHistoricoSoftruckPDF(
    @Query() query: HistoricoQueryDto,
    @Res() res: Response,
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    const pdfBuffer =
      await this.rastreamentoService.gerarRelatorioHistoricoSoftruckPDF(
        query.chassi,
        query.dataInicial,
        query.dataFinal,
        baseOrigin,
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
  async obterRotasHistoricoSoftruck(
    @Query() query: HistoricoQueryDto,
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    return this.rastreamentoService.obterRotasHistoricoSoftruck(
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      baseOrigin,
    );
  }

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('comando')
  @Post('ancora-m7')
  async ancoraM7(
    @Body() body: { cnpj: string; chassi: string; ancora_ativa: boolean },
    @BaseOrigin() baseOrigin: BaseOriginType,
    @Req() req: Request,
  ) {
    return this.rastreamentoService.ancoraM7(
      body.cnpj,
      body.chassi,
      body.ancora_ativa,
      baseOrigin,
      autorDaRequisicao(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('comando')
  @Post('ignicao-m7')
  ignicaoM7(
    @Body() body: { cnpj: string; chassi: string; evt_ign: boolean },
    @BaseOrigin() baseOrigin: BaseOriginType,
    @Req() req: Request,
  ) {
    return this.rastreamentoService.ignicaoM7(
      body.cnpj,
      body.chassi,
      body.evt_ign,
      baseOrigin,
      autorDaRequisicao(req),
    );
  }

  // Exige só autenticação (o app já envia o Bearer); sem checagem de posse,
  // como nas demais rotas de rastreamento.
  @UseGuards(JwtAuthGuard)
  @Get('ignicao-status')
  async getIgnicaoStatus(@Query('chassi') chassi: string, @Req() req: Request) {
    return this.rastreamentoService.getIgnicaoStatus(
      chassi,
      autorDaRequisicao(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('ancora-status')
  async getAncoraStatus(@Query('chassi') chassi: string, @Req() req: Request) {
    return this.rastreamentoService.getAncoraStatus(
      chassi,
      autorDaRequisicao(req),
    );
  }

  // ROTAS REFERENTES AO RASTREAMENTO LÓGICA SOLUÇÕES

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('posicao')
  @Post('ultima-posicao-logica')
  async ultimaPosicaoLogica(
    @Body() body: { chassi: string },
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    return this.rastreamentoService.ultimaPosicaoLogica(
      body.chassi,
      undefined,
      { baseOrigin },
    );
  }

  // ROTAS REFERENTES AO RASTREAMENTO SOFTRUCK

  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('posicao')
  @Post('ultima-posicao-softruck')
  async ultimaPosicaoSoftruck(
    @Body() body: { chassi: string },
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    return this.rastreamentoService.ultimaPosicaoSoftruck(
      body.chassi,
      baseOrigin,
    );
  }

  //WEBHOOKS

  // Webhook M7 para eventos de rastreamento
  @UseGuards(M7WebhookGuard)
  @LimiteDeTaxa('nenhuma')
  @Post('webhook-m7')
  async webhookM7(@Body() payload: unknown) {
    // O id do job sai do hash do evento: a reentrega da M7 enquanto o job
    // existe não cria outro. Retry e retenção vêm do padrão da fila.
    const job = await this.webhookQueue.add(
      JOB_EVENTO_M7,
      { payload },
      { jobId: idDoJobDoEventoM7(extrairEventoM7(payload).hash) },
    );
    return { queued: true, jobId: job.id };
  }
}
