import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostosService } from './postos.service';
import { PostosRequestDto } from './dto/postos-request.dto';

@UseGuards(JwtAuthGuard)
@Controller('postos')
export class PostosController {
  constructor(private readonly postosService: PostosService) {}

  @Post('buscar')
  async buscarPostos(@Body() body: PostosRequestDto, @Req() req) {
    const userId = req.user.userId;
    return this.postosService.buscarPostos(body.latitude, body.longitude, userId);
  }
}
