import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ConfirmarContatoDto,
  ParticiparDto,
} from 'src/associado-sorte/dto/app.dto';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteAppService } from 'src/associado-sorte/services/sorte-app.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteLojaService } from 'src/associado-sorte/services/sorte-loja.service';
import { SorteParticipacaoService } from 'src/associado-sorte/services/sorte-participacao.service';
import { SorteRaspadinhaService } from 'src/associado-sorte/services/sorte-raspadinha.service';
import { SorteResgateService } from 'src/associado-sorte/services/sorte-resgate.service';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';

type AppRequest = Request & { user?: { userId?: number | string } };

/**
 * Rotas do app do associado — Associado da Sorte (contrato v2).
 * A base vem sempre do JWT (`@BaseOrigin()`), nunca do corpo. Toda resposta
 * com horário inclui `serverNow` para o cronômetro do app.
 *
 * Todas exigem inscrição (403 `NAO_INSCRITO`), exceto `resumo` e
 * `regulamento`. As rotas de rodada respondem 404 com
 * `rodadasHabilitadas = false`.
 */
@ApiTags('Associado da Sorte')
@ApiBearerAuth()
@Controller('associado-sorte')
@UseGuards(JwtAuthGuard)
export class AssociadoSorteAppController {
  constructor(
    private readonly app: SorteAppService,
    private readonly acesso: SorteAcessoService,
    private readonly raspadinha: SorteRaspadinhaService,
    private readonly loja: SorteLojaService,
    private readonly participacao: SorteParticipacaoService,
    private readonly resgate: SorteResgateService,
    private readonly creditos: SorteCreditosService,
    private readonly ganhadores: SorteGanhadoresService,
  ) {}

  @Get('resumo')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Tela inicial em uma chamada: inscrição, convite, saldo, raspadinha, jornada e campanha',
  })
  resumo(@BaseOrigin() baseOrigin: string, @Req() req: AppRequest) {
    return this.app.resumo(this.userId(req), baseOrigin);
  }

  @Post('raspar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Raspa (resultado decidido no servidor antes da animação): voucher do momento liberado ou "não foi dessa vez"',
  })
  raspar(@BaseOrigin() baseOrigin: string, @Req() req: AppRequest) {
    return this.raspadinha.raspar({ userId: this.userId(req), baseOrigin });
  }

  @Get('loja')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Produtos da Loja da Sorte e saldo' })
  listarLoja(@BaseOrigin() baseOrigin: string, @Req() req: AppRequest) {
    return this.loja.listar(this.userId(req), baseOrigin);
  }

  @Post('loja/:premioId/comprar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compra o produto com créditos (gera o pedido)' })
  comprar(
    @Param('premioId', ParseIntPipe) premioId: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    return this.loja.comprar({
      premioId,
      userId: this.userId(req),
      baseOrigin,
    });
  }

  @Get('extrato')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Lançamentos de créditos (paginado)' })
  async extrato(
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
    @Query() query: PaginacaoQuery,
  ) {
    const userId = this.userId(req);
    await this.acesso.validar(userId, baseOrigin, { rota: 'extrato' });
    return this.creditos.extratoApp(userId, query);
  }

  @Get('regulamento')
  @ApiOperation({ summary: 'Texto do regulamento (não exige inscrição)' })
  regulamento(@BaseOrigin() baseOrigin: string) {
    return this.app.regulamento(baseOrigin);
  }

  @Get('meus-premios')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Pedidos da loja e prêmios, com código e situação' })
  async meusPremios(@BaseOrigin() baseOrigin: string, @Req() req: AppRequest) {
    const userId = this.userId(req);
    await this.acesso.validar(userId, baseOrigin, { rota: 'meus-premios' });
    return this.ganhadores.meusPremios(userId, baseOrigin);
  }

  @Get('meus-premios/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Detalhe do pedido/prêmio' })
  async meuPremio(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    const userId = this.userId(req);
    await this.acesso.validar(userId, baseOrigin, { rota: 'meus-premios' });
    return this.ganhadores.meuPremio(id, userId, baseOrigin);
  }

  @Patch('meus-premios/:id/contato')
  @ApiOperation({ summary: 'Confirma o WhatsApp de contato do ganhador' })
  async confirmarContato(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
    @Body() body: ConfirmarContatoDto,
  ) {
    const userId = this.userId(req);
    await this.acesso.validar(userId, baseOrigin, { rota: 'meus-premios' });
    return this.ganhadores.confirmarContato({
      id,
      userId,
      baseOrigin,
      telefone: body.telefone,
    });
  }

  // ------------------------- rodadas do piloto (atrás de rodadasHabilitadas)

  @Get('rodadas/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Detalhe da rodada (404 com rodadas desligadas)' })
  async rodada(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    const userId = this.userId(req);
    await this.acesso.exigirRodadasHabilitadas(baseOrigin);
    await this.acesso.validar(userId, baseOrigin, { rota: 'rodadas' });
    return this.app.detalharRodada(id, userId, baseOrigin);
  }

  @Post('rodadas/:id/participar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inscrição em sorteio (404 com rodadas desligadas)',
  })
  async participar(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
    @Body() body: ParticiparDto,
  ) {
    await this.acesso.exigirRodadasHabilitadas(baseOrigin);
    return this.participacao.participar({
      rodadaId: id,
      userId: this.userId(req),
      baseOrigin,
      bilhetes: body?.bilhetes,
    });
  }

  @Post('rodadas/:id/resgatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resgate em corrida/vitrine (404 com rodadas desligadas)',
  })
  async resgatar(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    await this.acesso.exigirRodadasHabilitadas(baseOrigin);
    return this.resgate.resgatar({
      rodadaId: id,
      userId: this.userId(req),
      baseOrigin,
    });
  }

  @Post('rodadas/:id/lembrete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liga o "Avise-me" (404 com rodadas desligadas)' })
  async ligarLembrete(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    await this.acesso.exigirRodadasHabilitadas(baseOrigin);
    return this.participacao.ligarLembrete({
      rodadaId: id,
      userId: this.userId(req),
      baseOrigin,
    });
  }

  @Delete('rodadas/:id/lembrete')
  @ApiOperation({
    summary: 'Desliga o "Avise-me" (404 com rodadas desligadas)',
  })
  async desligarLembrete(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    await this.acesso.exigirRodadasHabilitadas(baseOrigin);
    return this.participacao.desligarLembrete({
      rodadaId: id,
      userId: this.userId(req),
    });
  }

  private userId(req: AppRequest): number {
    return Number(req.user?.userId);
  }
}
