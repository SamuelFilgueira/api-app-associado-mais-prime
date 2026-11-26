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
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';
import { UpdateAssociadoDto } from 'src/associado/dto/update-associado.dto';
import { PrimeiroAcessoDto } from 'src/associado/dto/primeiro-acesso.dto';
import { PosseContaService } from 'src/infra/auth/posse-conta.service';
import {
  UsuarioAutenticado,
  exigirDonoOuAdmin,
} from 'src/infra/auth/usuario-autenticado';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { LIMITE_IMAGEM } from 'src/infra/storage/limites-de-upload';

@Controller('associado')
export class AssociadoController {
  private readonly logger = new Logger(AssociadoController.name);

  constructor(
    private readonly associadoService: AssociadoService,
    private readonly posseConta: PosseContaService,
  ) {}

  @HttpCode(201)
  @LimiteDeTaxa('primeiro_acesso')
  @Post('primeiro-acesso')
  async primeiroAcesso(@Body() data: PrimeiroAcessoDto) {
    return this.associadoService.primeiroAcesso(data.cpf);
  }

  /**
   * Usada pelo painel (busca do associado para o reset de senha) e, com o
   * próprio CPF, pelo app. Exige token: associado só consulta o próprio
   * documento; `role` ADMIN consulta qualquer um. A resposta nunca traz o hash.
   */
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Get('cpf')
  async findByCpf(@Query('cpf') cpf: string, @Request() req: RequisicaoHttp) {
    await this.posseConta.exigirDocumentoProprioOuAdmin(req.user, cpf);
    const resposta = await this.associadoService.findByCpf(cpf);
    return resposta;
  }

  /** Perfil do associado: só o dono da conta ou `role` ADMIN. */
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findById(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: RequisicaoHttp,
  ) {
    exigirDonoOuAdmin(req.user, id);
    const resposta = await this.associadoService.findById(id);
    return resposta;
  }

  // @Get('base-origin/:cpf')
  // async findBaseOriginByCpf(@Param('cpf') cpf: string) {
  //   return this.associadoService.findBaseOriginByCpf(cpf);
  // }

  /**
   * O app chama logo após o login, já com o Bearer. Sem token, a rota servia
   * para descobrir a situação de qualquer CPF e disparava até 3 consultas por
   * base na Hinova para quem pedisse.
   */
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @LimiteDeTaxa('sga')
  @Get('verificar-situacao/:cpf')
  async verificarSituacao(
    @Param('cpf') cpf: string,
    @Request() req: RequisicaoHttp,
  ) {
    await this.posseConta.exigirDocumentoProprioOuAdmin(req.user, cpf);
    return this.associadoService.verificarSituacao(cpf);
  }

  @HttpCode(200)
  @Get('cpf/:cpf/veiculos')
  @UseGuards(JwtAuthGuard)
  async findVehiclesByCpf(
    @Param('cpf') cpf: string,
    @Request() req: RequisicaoHttp,
    // Opcional: a rota também atende o painel (ADMIN), cujo token não tem
    // base. Aqui a base só vai para o log; a consulta não depende dela.
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ) {
    await this.posseConta.exigirDocumentoProprioOuAdmin(req.user, cpf);
    this.logger.log(
      `Base origin da request autenticada: ${baseOrigin ?? '(token sem base)'}`,
    );
    return this.associadoService.findVehiclesByCpf(cpf);
  }

  @HttpCode(200)
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('profilePhoto', LIMITE_IMAGEM))
  updateAssociado(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: RequisicaoHttp,
    @Body() data: UpdateAssociadoDto,
    @UploadedFile() profilePhoto?: Express.Multer.File,
  ) {
    exigirDonoOuAdmin(req.user, id);
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
   *
   * Autorização: o dono da conta ou um token com `role` ADMIN (painel e ADMIN
   * legado). Um associado não troca a senha de outro.
   */
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Patch(':id/password')
  async changePassword(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: RequisicaoHttp,
    @Body() body: { newPassword: string },
  ) {
    exigirDonoOuAdmin(req.user, id);
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
  user?: UsuarioAutenticado;
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
