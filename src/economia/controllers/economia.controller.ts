import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { EconomiaService } from 'src/economia/services/economia.service';

@UseGuards(JwtAuthGuard)
@Controller('economia')
export class EconomiaController {
  constructor(private readonly economiaService: EconomiaService) {}

  @Get('total')
  async consultarTotal(@Req() req) {
    const userId = req.user.userId;
    return this.economiaService.consultarTotalEconomizado(userId);
  }
}
