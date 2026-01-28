import { Controller, Post, Body, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostosService } from './postos.service';
import { PostosRequestDto } from './dto/postos-request.dto';

@UseGuards(JwtAuthGuard)
@Controller('postos')
export class PostosController {
  constructor(private readonly postosService: PostosService) {}

  @Post('buscar')
  async buscarPostos(
    @Body() body: PostosRequestDto,
    @Req() req,
    @Query('page') page: string,
  ) {
    console.log('Body recebido para buscarPostos:', body);
    console.log('Query page recebido para buscarPostos:', page);
    const userId = req.user.userId;
    const pageNumber = page ? parseInt(page, 10) : 1;
    return this.postosService.buscarPostos(
      body.latitude,
      body.longitude,
      userId,
      pageNumber,
    );
  }
}
