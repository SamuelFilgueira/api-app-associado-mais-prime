import { UseGuards, Request, Logger, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  AssociadoService,
  PasswordChangeActor,
} from 'src/associado/services/associado.service';
import { BaseContextService } from 'src/shared/base-context.service';
import { UpdateAssociadoDto } from 'src/associado/dto/update-associado.dto';
import { PrimeiroAcessoDto } from 'src/associado/dto/primeiro-acesso.dto';

@Controller('associado')
export class AssociadoController {
  private readonly logger = new Logger(AssociadoController.name);

  constructor(
    private readonly associadoService: AssociadoService,
    private readonly baseContextService: BaseContextService,
  ) {}

  @HttpCode(201)
  @Post('primeiro-acesso')
  async primeiroAcesso(@Body() data: PrimeiroAcessoDto) {
    return this.associadoService.primeiroAcesso(data.cpf);
  }

  @HttpCode(200)
  @Get('cpf')
  async findByCpf(@Query('cpf') cpf: string) {
    const resposta = await this.associadoService.findByCpf(cpf);
    return resposta;
  }

  @HttpCode(200)
  @Get(':id')
  async findById(@Param('id', ParseIntPipe) id: number) {
    const resposta = await this.associadoService.findById(id);
    return resposta;
  }

  // @Get('base-origin/:cpf')
  // async findBaseOriginByCpf(@Param('cpf') cpf: string) {
  //   return this.associadoService.findBaseOriginByCpf(cpf);
  // }

  @HttpCode(200)
  @Get('verificar-situacao/:cpf')
  async verificarSituacao(@Param('cpf') cpf: string) {
    return this.associadoService.verificarSituacao(cpf);
  }

  @HttpCode(200)
  @Get('cpf/:cpf/veiculos')
  @UseGuards(JwtAuthGuard)
  async findVehiclesByCpf(@Param('cpf') cpf: string) {
    // Exemplo de uso de BaseContextService em rota autenticada
    try {
      const baseOrigin = this.baseContextService.getBaseOrigin();
      this.logger.log(`Base origin da request autenticada: ${baseOrigin}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.error(
        `Erro ao obter token via BaseContextService: ${message}`,
      );
    }
    return this.associadoService.findVehiclesByCpf(cpf);
  }

  @HttpCode(200)
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('profilePhoto'))
  updateAssociado(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateAssociadoDto,
    @UploadedFile() profilePhoto?: Express.Multer.File,
  ) {
    return this.associadoService.updateAssociado(id, data, profilePhoto);
  }

  /**
   * Rota para troca de senha
   * PATCH /associado/:id/password
   * Body: { newPassword: string }
   * Header: Authorization: Bearer <token>
   *
   * Usada pelo app (associado troca a própria senha) e pelo painel
   * administrativo (reset). Quem pediu vai para a auditoria
   * `UserPasswordChangeLog`: token do painel carrega `adminRole`.
   */
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Patch(':id/password')
  async changePassword(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: RequisicaoHttp,
    @Body() body: { newPassword: string },
  ) {
    const ator: PasswordChangeActor = {
      userId: req.user?.userId,
      email: req.user?.email,
      adminRole: req.user?.adminRole,
      ipAddress: extrairIpCliente(req),
      userAgent: extrairUserAgent(req),
    };
    return this.associadoService.changePassword(id, body.newPassword, ator);
  }
}

interface RequisicaoHttp {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  /** Payload do JWT (JwtStrategy.validate). */
  user?: {
    userId?: number | string;
    email?: string;
    adminRole?: string;
  };
}

function extrairIpCliente(req: RequisicaoHttp): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0]?.trim();
  }
  return req.socket?.remoteAddress?.replace(/^::ffff:/, '');
}

function extrairUserAgent(req: RequisicaoHttp): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua.trim().length > 0 ? ua : undefined;
}
