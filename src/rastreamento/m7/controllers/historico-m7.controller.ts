import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { JwtUser } from 'src/auth/jwt-user.interface';
import { BaseContextService } from 'src/shared/base-context.service';
import { HistoricoM7QueryDto } from '../dto/historico-m7-query.dto';
import { HistoricoM7Service } from '../services/historico-m7.service';
import { HistoricoM7ResumoResponseDto } from '../dto/historico-m7-response.dto';

@Controller('rastreamento/historico/m7')
export class HistoricoM7Controller {
  constructor(
    private readonly historicoM7Service: HistoricoM7Service,
    private readonly baseContextService: BaseContextService,
  ) {}

  /**
   * Gera o relatório PDF de trajetórias M7 para o veículo do usuário autenticado.
   *
   * GET /rastreamento/historico/m7/pdf
   *   ?cnpj=XX.XXX.XXX/0001-XX
   *   &chassi=XXXXXXXXXXXXXXXXX
   *   &dataInicial=YYYY-MM-DD
   *   &dataFinal=YYYY-MM-DD
   */
  @UseGuards(JwtAuthGuard)
  @Get('pdf')
  async gerarPdf(
    @Query() query: HistoricoM7QueryDto,
    @Req() req: Request & { user?: JwtUser },
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user;
    const baseOrigin = this.baseContextService.getBaseOrigin();

    const pdfBuffer = await this.historicoM7Service.gerarPdf(
      query.cnpj,
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      baseOrigin,
    );

    const safeChassi = (query.chassi || 'veiculo').replace(
      /[^A-Za-z0-9_-]/g,
      '',
    );
    const fileName = `historico-m7-${safeChassi}-${query.dataInicial}-${query.dataFinal}.pdf`;

    void user;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  }

  /**
   * Retorna o histórico de trajetórias M7 agrupado por data, sem pontos GPS.
   *
   * GET /rastreamento/historico/m7/resumo
   *   ?cnpj=XX.XXX.XXX/0001-XX
   *   &chassi=XXXXXXXXXXXXXXXXX
   *   &dataInicial=YYYY-MM-DD
   *   &dataFinal=YYYY-MM-DD
   */
  @UseGuards(JwtAuthGuard)
  @Get('resumo')
  async obterResumo(
    @Query() query: HistoricoM7QueryDto,
    @Req() req: Request & { user?: JwtUser },
  ): Promise<HistoricoM7ResumoResponseDto> {
    void req.user;
    const baseOrigin = this.baseContextService.getBaseOrigin();

    return this.historicoM7Service.obterResumo(
      query.cnpj,
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      baseOrigin,
    );
  }

  /**
   * Retorna os pontos GPS do histórico de rotas M7 para o veículo do usuário autenticado.
   *
   * GET /rastreamento/historico/m7/rotas
   *   ?cnpj=XX.XXX.XXX/0001-XX
   *   &chassi=XXXXXXXXXXXXXXXXX
   *   &dataInicial=YYYY-MM-DD
   *   &dataFinal=YYYY-MM-DD
   */
  @UseGuards(JwtAuthGuard)
  @Get('rotas')
  async obterRotas(
    @Query() query: HistoricoM7QueryDto,
    @Req() req: Request & { user?: JwtUser },
  ) {
    const user = req.user;
    const baseOrigin = this.baseContextService.getBaseOrigin();

    void user;

    return this.historicoM7Service.obterRotas(
      query.cnpj,
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      baseOrigin,
    );
  }
}
