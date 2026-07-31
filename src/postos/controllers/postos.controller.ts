import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Query,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { PostosService } from 'src/postos/services/postos.service';
import { PostosRequestDto } from 'src/postos/dto/postos-request.dto';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';

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
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    this.logger.log(`Body recebido para buscarPostos: ${JSON.stringify(body)}`);
    this.logger.log(`Query page recebido para buscarPostos: ${page}`);
    const userId = req.user.userId;
    const pageNumber = page ? parseInt(page, 10) : 1;
    return this.postosService.buscarPostos(
      body.latitude,
      body.longitude,
      userId,
      body.chassi,
      pageNumber,
      baseOrigin,
    );
  }
}
