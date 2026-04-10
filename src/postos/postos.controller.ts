import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Query,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostosService } from './postos.service';
import { PostosRequestDto } from './dto/postos-request.dto';
import { BaseContextService } from '../shared/base-context.service';
import { TokenResolverService } from '../shared/token-resolver.service';

@UseGuards(JwtAuthGuard)
@Controller('postos')
export class PostosController {
  private readonly logger = new Logger(PostosController.name);

  constructor(
    private readonly postosService: PostosService,
    private readonly baseContextService: BaseContextService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  private maskSecret(value?: string): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

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
    const baseOrigin = this.baseContextService.getBaseOrigin();
    const clubgasTokenKey = this.tokenResolver.getTokenKey(baseOrigin, 'clubgas');
    const clubgasToken = this.baseContextService.getClubgasToken();
    this.logger.log(
      `[${baseOrigin}] postos buscar usando tokenKey=${clubgasTokenKey} token=${this.maskSecret(clubgasToken)}`,
    );
    return this.postosService.buscarPostos(
      body.latitude,
      body.longitude,
      userId,
      body.chassi,
      pageNumber,
      clubgasToken,
      baseOrigin,
      clubgasTokenKey,
    );
  }
}
