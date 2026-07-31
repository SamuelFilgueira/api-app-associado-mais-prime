import {
  Controller,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { JwtUser } from 'src/auth/interfaces/jwt-user.interface';
import { BaseContextService } from 'src/shared/base-context.service';
import {
  HistoricoM7ContestacaoQueryDto,
  HistoricoM7QueryDto,
} from '../dto/historico-m7-query.dto';
import { HistoricoM7Service } from '../services/historico-m7.service';
import { HistoricoM7ResumoResponseDto } from '../dto/historico-m7-response.dto';

@Controller('rastreamento/historico/m7')
export class HistoricoM7Controller {
  private readonly logger = new Logger(HistoricoM7Controller.name);

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

    this.logger.log(
      `[${baseOrigin}] gerarPdf M7 solicitado | cnpj=${query.cnpj} chassi=${query.chassi} dataInicial=${query.dataInicial} dataFinal=${query.dataFinal}`,
    );

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
   * Gera o relatório PDF de trajetórias M7 (v2) com abordagem baseada
   * no histórico sequencial/ignição. Mantido em paralelo para validação.
   *
   * GET /rastreamento/historico/m7/pdf-v2
   *   ?cnpj=XX.XXX.XXX/0001-XX
   *   &chassi=XXXXXXXXXXXXXXXXX
   *   &dataInicial=YYYY-MM-DD
   *   &dataFinal=YYYY-MM-DD
   */
  @UseGuards(JwtAuthGuard)
  @Get('pdf-v2')
  async gerarPdfV2(
    @Query() query: HistoricoM7QueryDto,
    @Req() req: Request & { user?: JwtUser },
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user;
    const baseOrigin = this.baseContextService.getBaseOrigin();

    this.logger.log(
      `[${baseOrigin}] gerarPdfV2 M7 solicitado | cnpj=${query.cnpj} chassi=${query.chassi} dataInicial=${query.dataInicial} dataFinal=${query.dataFinal}`,
    );

    const pdfBuffer = await this.historicoM7Service.gerarPdfV2(
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
    const fileName = `historico-m7-v2-${safeChassi}-${query.dataInicial}-${query.dataFinal}.pdf`;

    void user;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  }

  /**
   * Gera o relatório PDF de contestação de multa M7 para o veículo do usuário autenticado.
   *
   * GET /rastreamento/historico/m7/pdf-contestacao
   *   ?cnpj=XX.XXX.XXX/0001-XX
   *   &chassi=XXXXXXXXXXXXXXXXX
   *   &dataInicial=YYYY-MM-DD
   *   &dataFinal=YYYY-MM-DD
   */
  @UseGuards(JwtAuthGuard)
  @Get('pdf-contestacao')
  async gerarPdfContestacao(
    @Query() query: HistoricoM7ContestacaoQueryDto,
    @Req() req: Request & { user?: JwtUser },
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user;
    const baseOrigin = this.baseContextService.getBaseOrigin();

    this.logger.log(
      `[${baseOrigin}] gerarPdfContestacao M7 solicitado | cnpj=${query.cnpj} chassi=${query.chassi} dataInicial=${query.dataInicial} dataFinal=${query.dataFinal}`,
    );

    const pdfBuffer = await this.historicoM7Service.gerarPdfContestacao(
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
    const fileName = `historico-m7-contestacao-${safeChassi}-${query.dataInicial}-${query.dataFinal}.pdf`;

    void user;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  }

  /**
   * Gera o relatório PDF de contestação de multa M7 (v2) com todos os pontos GPS
   * geocodificados individualmente via banco nominatim_rj.
   * Sem gráficos — informações brutas para análise de infrações.
   *
   * GET /rastreamento/historico/m7/pdf-contestacao-v2
   *   ?cnpj=XX.XXX.XXX/0001-XX
   *   &chassi=XXXXXXXXXXXXXXXXX
   *   &dataInicial=YYYY-MM-DD
   *   &dataFinal=YYYY-MM-DD
   */
  @UseGuards(JwtAuthGuard)
  @Get('pdf-contestacao-v2')
  async gerarPdfContestacaoV2(
    @Query() query: HistoricoM7ContestacaoQueryDto,
    @Req() req: Request & { user?: JwtUser },
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user;
    const baseOrigin = this.baseContextService.getBaseOrigin();

    this.logger.log(
      `[${baseOrigin}] gerarPdfContestacaoV2 M7 solicitado | cnpj=${query.cnpj} chassi=${query.chassi} dataInicial=${query.dataInicial} dataFinal=${query.dataFinal}`,
    );

    const pdfBuffer = await this.historicoM7Service.gerarPdfContestacaoV2(
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
    const fileName = `historico-m7-contestacao-v2-${safeChassi}-${query.dataInicial}-${query.dataFinal}.pdf`;

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
