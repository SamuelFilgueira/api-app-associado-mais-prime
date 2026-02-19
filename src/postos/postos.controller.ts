import { Controller, Post, Body, UseGuards, Req, Query, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostosService } from './postos.service';
import { PostosRequestDto } from './dto/postos-request.dto';

@UseGuards(JwtAuthGuard)
@Controller('postos')
export class PostosController {
  private readonly logger = new Logger(PostosController.name);

  constructor(private readonly postosService: PostosService) {}

  @Post('buscar')
  async buscarPostos(
    @Body() body: PostosRequestDto,
    @Req() req,
    @Query('page') page: string,
  ) {
    this.logger.log(`Body recebido para buscarPostos: ${JSON.stringify(body)}`);
    this.logger.log(`Query page recebido para buscarPostos: ${page}`);
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
