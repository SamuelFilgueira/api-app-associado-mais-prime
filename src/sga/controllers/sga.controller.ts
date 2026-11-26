import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ehChassiValido } from 'src/sga/domain/parametros-sga';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { SgaService } from 'src/sga/services/sga.service';
import { SetRevistoriaDto } from 'src/sga/dto/set-revistoria.dto';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { SomenteAssociadoGuard } from 'src/infra/guards/somente-associado.guard';

@UseGuards(JwtAuthGuard, SomenteAssociadoGuard)
@LimiteDeTaxa('sga')
@Controller('sga')
export class SgaController {
  constructor(private readonly sgaService: SgaService) {}

  @Get('associado')
  async consultarAssociado(@Req() req) {
    const userId = Number(req.user.userId);
    return this.sgaService.consultarAssociado(userId);
  }

  @Get('veiculos')
  async consultarVeiculos(@Req() req) {
    const userId = Number(req.user.userId);
    return this.sgaService.consultarVeiculosAssociado(userId);
  }

  @Get('veiculos-info/:chassi')
  consultarVeiculoInfo(
    @Param('chassi') chassi: string,
    @Req() req: { user?: { baseOrigin?: string } },
  ) {
    // O chassi entra no caminho da chamada ao SGA: só letras e números.
    if (!ehChassiValido(chassi)) {
      throw new BadRequestException(
        'chassi inválido: use de 6 a 20 letras e números',
      );
    }
    return this.sgaService.consultarVeiculoInfo(
      chassi.trim(),
      req.user?.baseOrigin,
    );
  }

  @Patch('set-revistoria')
  @HttpCode(204)
  async setRevistoria(@Body() body: SetRevistoriaDto) {
    return this.sgaService.setRevistoria(
      body.chassi,
      body.reinspectionRequired,
    );
  }
}
