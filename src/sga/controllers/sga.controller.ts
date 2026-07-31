import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { SgaService } from 'src/sga/services/sga.service';
import { SetRevistoriaDto } from 'src/sga/dto/set-revistoria.dto';

@UseGuards(JwtAuthGuard)
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
  consultarVeiculoInfo(@Param('chassi') chassi: string) {
    return this.sgaService.consultarVeiculoInfo(chassi);
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
