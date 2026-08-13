import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { BaseContextService } from 'src/shared/base-context.service';
import { TokenResolverService } from 'src/shared/token-resolver.service';
import { TrajetoQueryDto } from '../dto/trajeto-query.dto';
import { TrajetosService } from '../services/trajetos.service';

@Controller('rastreamento/logica/trajetos')
export class TrajetosController {
  constructor(
    private readonly trajetosService: TrajetosService,
    private readonly baseContextService: BaseContextService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('relatorio')
  async obterRelatorio(
    @Query() query: TrajetoQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const baseOrigin = this.baseContextService.getBaseOrigin();
    const token = this.tokenResolver.resolveLogicaToken(baseOrigin);

    const pdfBuffer = await this.trajetosService.obterRelatorio({
      chassi: query.chassi,
      dataInicial: query.dataInicial,
      dataFinal: query.dataFinal,
      token,
      baseOrigin,
    });

    const safeChassi = (query.chassi || 'veiculo').replace(
      /[^A-Za-z0-9_-]/g,
      '',
    );
    const fileName = `historico-logica-${safeChassi}-${query.dataInicial}-${query.dataFinal}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  }
}
