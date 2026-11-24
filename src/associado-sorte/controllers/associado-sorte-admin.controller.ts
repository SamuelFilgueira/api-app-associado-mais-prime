import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { DashboardQuery } from 'src/associado-sorte/dto/app.dto';
import {
  AtualizarCampanhaDto,
  AtualizarMomentoDto,
  CriarCampanhaDto,
  EncerrarCampanhaDto,
  ImportarCronogramaDto,
  ListarCampanhasQuery,
  ListarMomentosQuery,
  MomentoDto,
  PublicarCampanhaDto,
} from 'src/associado-sorte/dto/campanha.dto';
import {
  ListarInscricoesQuery,
  MarcarInscricaoDto,
} from 'src/associado-sorte/dto/inscricao.dto';
import {
  BaseOpcionalQuery,
  ListarNotificacoesQuery,
} from 'src/associado-sorte/dto/notificacao.dto';
import {
  AjusteCreditosDto,
  BuscarAssociadosQuery,
} from 'src/associado-sorte/dto/associado.dto';
import {
  AtualizarGanhadorDto,
  ListarGanhadoresQuery,
} from 'src/associado-sorte/dto/ganhador.dto';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import {
  AtualizarPremioDto,
  CriarPremioDto,
  ListarPremiosQuery,
  MovimentarEstoqueDto,
} from 'src/associado-sorte/dto/premio.dto';
import {
  AtualizarRodadaDto,
  CriarRodadaDto,
  DuplicarRodadaDto,
  ListarRodadasQuery,
} from 'src/associado-sorte/dto/rodada.dto';
import { SalvarConfigDto } from 'src/associado-sorte/dto/salvar-config.dto';
import { SorteAutor } from 'src/associado-sorte/enums/associado-sorte.enums';
import { SorteApuracaoService } from 'src/associado-sorte/services/sorte-apuracao.service';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteInscricaoService } from 'src/associado-sorte/services/sorte-inscricao.service';
import { SorteNotificacoesAdminService } from 'src/associado-sorte/services/sorte-notificacoes-admin.service';
import { SorteRaspadinhaService } from 'src/associado-sorte/services/sorte-raspadinha.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';
import { SORTE_ARTE_ESPEC } from 'src/associado-sorte/helpers/sorte-arte.helper';
import { SorteArteService } from 'src/associado-sorte/services/sorte-arte.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteDashboardService } from 'src/associado-sorte/services/sorte-dashboard.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SortePremiosService } from 'src/associado-sorte/services/sorte-premios.service';
import { SorteRodadasService } from 'src/associado-sorte/services/sorte-rodadas.service';
import { AdminPanelRoles } from 'src/infra/decorators/admin-panel-roles.decorator';
import { AdminPanelRole } from 'src/infra/enums/admin-panel-role.enum';
import { AdminPanelRoleGuard } from 'src/infra/guards/admin-panel-role.guard';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';

const IMAGEM_MAX_BYTES = 5 * 1024 * 1024;
const IMAGEM_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type PanelRequest = Request & {
  user?: { userId?: number | string; username?: string; email?: string };
};

/**
 * Rotas do painel — Associado da Sorte. Perfil MARKETING (ADMIN sempre
 * passa). O painel enxerga todas as bases do deploy; a base de cada operação
 * vem na rota/consulta, validada como base do tenant.
 */
@ApiTags('Associado da Sorte')
@ApiBearerAuth()
@Controller('admin/associado-sorte')
@UseGuards(JwtAuthGuard, AdminPanelRoleGuard)
@AdminPanelRoles(AdminPanelRole.MARKETING)
export class AssociadoSorteAdminController {
  constructor(
    private readonly dashboardService: SorteDashboardService,
    private readonly config: SorteConfigService,
    private readonly arte: SorteArteService,
    private readonly premios: SortePremiosService,
    private readonly rodadas: SorteRodadasService,
    private readonly apuracao: SorteApuracaoService,
    private readonly ganhadores: SorteGanhadoresService,
    private readonly creditos: SorteCreditosService,
    private readonly campanhas: SorteCampanhaService,
    private readonly inscricoes: SorteInscricaoService,
    private readonly notificacoesAdmin: SorteNotificacoesAdminService,
    private readonly raspadinha: SorteRaspadinhaService,
    private readonly tentativas: SorteTentativaService,
  ) {}

  // Em cada bloco, rotas fixas antes de ":id" para não colidirem com o
  // ParseIntPipe.

  @Get('opcoes')
  @ApiOperation({ summary: 'Bases do deploy e rótulos dos enums' })
  opcoes() {
    return this.dashboardService.opcoes();
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Indicadores da base selecionada' })
  dashboard(@Query() query: DashboardQuery) {
    return this.dashboardService.dashboard(query.baseOrigin);
  }

  // ------------------------------------------------------------------ config

  @Get('config/:baseOrigin')
  @ApiOperation({ summary: 'Configuração da promoção na base' })
  obterConfig(@Param('baseOrigin') baseOrigin: string) {
    return this.config.obter(baseOrigin);
  }

  @Put('config/:baseOrigin')
  @ApiOperation({
    summary: 'Grava a configuração (campos omitidos ficam como estão)',
  })
  salvarConfig(
    @Param('baseOrigin') baseOrigin: string,
    @Body() body: SalvarConfigDto,
    @Req() req: PanelRequest,
  ) {
    return this.config.salvar(baseOrigin, body, this.autor(req));
  }

  // -------------------------------------------------- arte da raspadinha

  @Get('arte/especificacao')
  @ApiOperation({
    summary: 'Medidas, formatos e limites da arte da raspadinha',
  })
  especificacaoDaArte() {
    return this.arte.especificacao();
  }

  @Post('config/:baseOrigin/arte/:slot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Envia a arte da raspadinha (slot: capa | ganhou | naoGanhou; campo "arte"; 2:1, 1200×600 px; capa só estática; GIF/WebP animado só em ganhou/naoGanhou)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { arte: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('arte', {
      limits: { fileSize: SORTE_ARTE_ESPEC.uploadMaxBytes },
      fileFilter: (_req, file, callback) => {
        if (
          !(SORTE_ARTE_ESPEC.mimeTypes as readonly string[]).includes(
            file.mimetype,
          )
        ) {
          callback(
            new BadRequestException(
              'A arte deve ser PNG, JPG, WebP ou GIF. Vídeo (MP4) não é aceito.',
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  salvarArte(
    @Param('baseOrigin') baseOrigin: string,
    @Param('slot') slot: string,
    @Req() req: PanelRequest,
    @UploadedFile() arte?: Express.Multer.File,
  ) {
    return this.arte.salvar(baseOrigin, slot, arte, this.autor(req));
  }

  @Delete('config/:baseOrigin/arte/:slot')
  @ApiOperation({
    summary: 'Remove a arte do espaço (o app volta ao visual padrão)',
  })
  removerArte(
    @Param('baseOrigin') baseOrigin: string,
    @Param('slot') slot: string,
    @Req() req: PanelRequest,
  ) {
    return this.arte.remover(baseOrigin, slot, this.autor(req));
  }

  // ----------------------------------------------------------------- prêmios

  @Get('premios')
  @ApiOperation({ summary: 'Lista prêmios com estoque e unidades reservadas' })
  listarPremios(@Query() query: ListarPremiosQuery) {
    return this.premios.listar(query);
  }

  @Post('premios')
  @ApiOperation({ summary: 'Cria prêmio (estoque inicial opcional)' })
  criarPremio(@Body() body: CriarPremioDto, @Req() req: PanelRequest) {
    return this.premios.criar(body, this.autor(req));
  }

  @Get('premios/:id')
  @ApiOperation({ summary: 'Detalha prêmio' })
  detalharPremio(@Param('id', ParseIntPipe) id: number) {
    return this.premios.detalhar(id);
  }

  @Patch('premios/:id')
  @ApiOperation({ summary: 'Edita prêmio (estoque muda só por /estoque)' })
  atualizarPremio(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AtualizarPremioDto,
  ) {
    return this.premios.atualizar(id, body);
  }

  @Delete('premios/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui prêmio (exclusão lógica)' })
  async excluirPremio(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.premios.excluir(id);
  }

  @Post('premios/:id/imagem')
  @ApiOperation({
    summary: 'Envia a foto do prêmio (JPG/PNG/WebP até 5 MB, campo "imagem")',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { imagem: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('imagem', {
      limits: { fileSize: IMAGEM_MAX_BYTES },
      fileFilter: (_req, file, callback) => {
        if (!IMAGEM_MIME_TYPES.includes(file.mimetype)) {
          callback(
            new BadRequestException('A imagem deve ser JPG, PNG ou WebP'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  salvarImagemDoPremio(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() imagem?: Express.Multer.File,
  ) {
    return this.premios.salvarImagem(id, imagem);
  }

  @Post('premios/:id/estoque')
  @ApiOperation({ summary: 'Entrada ou ajuste de estoque, com motivo' })
  movimentarEstoque(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: MovimentarEstoqueDto,
    @Req() req: PanelRequest,
  ) {
    return this.premios.movimentarEstoque(id, body, this.autor(req));
  }

  @Get('premios/:id/estoque/movimentos')
  @ApiOperation({ summary: 'Histórico de movimentações de estoque' })
  listarMovimentos(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginacaoQuery,
  ) {
    return this.premios.listarMovimentos(id, query);
  }

  // ----------------------------------------------------------------- rodadas

  @Get('rodadas')
  @ApiOperation({
    summary: 'Lista rodadas (período, estado, mecânica, base, prêmio)',
  })
  listarRodadas(@Query() query: ListarRodadasQuery) {
    return this.rodadas.listar(query);
  }

  @Post('rodadas')
  @ApiOperation({ summary: 'Cria rodada em rascunho' })
  criarRodada(@Body() body: CriarRodadaDto) {
    return this.rodadas.criar(body);
  }

  @Get('rodadas/:id')
  @ApiOperation({ summary: 'Detalha rodada, com resultado e ganhadores' })
  detalharRodada(@Param('id', ParseIntPipe) id: number) {
    return this.rodadas.detalhar(id);
  }

  @Patch('rodadas/:id')
  @ApiOperation({
    summary: 'Edita rodada (depois da abertura: só título e encerramento)',
  })
  atualizarRodada(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AtualizarRodadaDto,
  ) {
    return this.rodadas.atualizar(id, body);
  }

  @Post('rodadas/:id/publicar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publica o rascunho (valida estoque disponível)' })
  publicarRodada(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: PanelRequest,
  ) {
    return this.rodadas.publicar(id, this.autor(req));
  }

  @Post('rodadas/:id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancela a rodada e estorna os créditos consumidos',
  })
  cancelarRodada(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: PanelRequest,
  ) {
    return this.rodadas.cancelar(id, this.autor(req));
  }

  @Post('rodadas/:id/duplicar')
  @ApiOperation({
    summary: 'Repete semanalmente por N semanas (N rascunhos independentes)',
  })
  duplicarRodada(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: DuplicarRodadaDto,
  ) {
    return this.rodadas.duplicar(id, body.semanas);
  }

  @Get('rodadas/:id/participantes')
  @ApiOperation({ summary: 'Inscritos do sorteio (CPF mascarado)' })
  participantes(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginacaoQuery,
  ) {
    return this.rodadas.participantes(id, query);
  }

  @Post('rodadas/:id/apurar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apuração manual do sorteio (idempotente, para contingência)',
  })
  apurarRodada(@Param('id', ParseIntPipe) id: number) {
    return this.apuracao.apurar(id, 'MANUAL');
  }

  // -------------------------------------------------------------- ganhadores

  @Get('ganhadores')
  @ApiOperation({ summary: 'Lista ganhadores (situação, rodada, período)' })
  listarGanhadores(@Query() query: ListarGanhadoresQuery) {
    return this.ganhadores.listar(query);
  }

  @Patch('ganhadores/:id')
  @ApiOperation({
    summary: 'Muda situação/observação; ao cancelar pode devolver ao estoque',
  })
  atualizarGanhador(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AtualizarGanhadorDto,
    @Req() req: PanelRequest,
  ) {
    return this.ganhadores.atualizar(id, body, this.autor(req));
  }

  // --------------------------------------------------------------- campanhas

  @Get('campanhas')
  @ApiOperation({
    summary: 'Lista campanhas (base, estado) com contagem dos momentos',
  })
  listarCampanhas(@Query() query: ListarCampanhasQuery) {
    return this.campanhas.listar(query);
  }

  @Post('campanhas')
  @ApiOperation({ summary: 'Cria campanha em rascunho' })
  criarCampanha(@Body() body: CriarCampanhaDto, @Req() req: PanelRequest) {
    return this.campanhas.criar(body, this.autor(req));
  }

  @Get('campanhas/:id')
  @ApiOperation({ summary: 'Detalha a campanha' })
  detalharCampanha(@Param('id', ParseIntPipe) id: number) {
    return this.campanhas.detalhar(id);
  }

  @Patch('campanhas/:id')
  @ApiOperation({
    summary:
      'Edita a campanha (publicada: só o nome; período → CAMPANHA_TRAVADA)',
  })
  atualizarCampanha(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AtualizarCampanhaDto,
  ) {
    return this.campanhas.atualizar(id, body);
  }

  @Delete('campanhas/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui rascunho (publicada → CAMPANHA_TRAVADA)' })
  async excluirCampanha(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.campanhas.excluir(id);
  }

  @Post('campanhas/:id/cronograma/pre-visualizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valida o CSV do cronograma sem gravar (erros por linha)',
  })
  preVisualizarCronograma(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ImportarCronogramaDto,
  ) {
    return this.campanhas.preVisualizar(id, body);
  }

  @Post('campanhas/:id/cronograma/importar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Grava o cronograma do CSV (tudo ou nada; só rascunho)',
  })
  importarCronograma(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ImportarCronogramaDto,
    @Req() req: PanelRequest,
  ) {
    return this.campanhas.importar(id, body, this.autor(req));
  }

  @Get('campanhas/:id/momentos')
  @ApiOperation({ summary: 'Momentos premiados com status e ganhador' })
  listarMomentos(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListarMomentosQuery,
  ) {
    return this.campanhas.listarMomentos(id, query);
  }

  @Post('campanhas/:id/momentos')
  @ApiOperation({ summary: 'Cria um momento (só rascunho)' })
  criarMomento(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: MomentoDto,
  ) {
    return this.campanhas.criarMomento(id, body);
  }

  @Patch('campanhas/:id/momentos/:momentoId')
  @ApiOperation({ summary: 'Edita um momento (só rascunho)' })
  atualizarMomento(
    @Param('id', ParseIntPipe) id: number,
    @Param('momentoId', ParseIntPipe) momentoId: number,
    @Body() body: AtualizarMomentoDto,
  ) {
    return this.campanhas.atualizarMomento(id, momentoId, body);
  }

  @Delete('campanhas/:id/momentos/:momentoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Apaga um momento (só rascunho)' })
  async excluirMomento(
    @Param('id', ParseIntPipe) id: number,
    @Param('momentoId', ParseIntPipe) momentoId: number,
  ): Promise<void> {
    await this.campanhas.excluirMomento(id, momentoId);
  }

  @Post('campanhas/:id/publicar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publica e TRAVA (grava o SHA-256 do cronograma)' })
  publicarCampanha(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PublicarCampanhaDto,
    @Req() req: PanelRequest,
  ) {
    return this.campanhas.publicar(id, body, this.autor(req));
  }

  @Post('campanhas/:id/encerrar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Encerra a campanha publicada (fica registrado)' })
  encerrarCampanha(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncerrarCampanhaDto,
    @Req() req: PanelRequest,
  ) {
    return this.campanhas.encerrar(id, body, this.autor(req));
  }

  @Get('campanhas/:id/auditoria')
  @ApiOperation({ summary: 'Exportação de auditoria (CSV ; UTF-8)' })
  async exportarAuditoria(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    // Valida antes de mandar o cabeçalho (404 continua JSON).
    await this.campanhas.detalhar(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="auditoria-campanha-${id}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      await this.campanhas.exportarAuditoria(id, (trecho) => {
        res.write(trecho);
      });
    } finally {
      res.end();
    }
  }

  // --------------------------------------------------------------- inscrições

  @Get('inscricoes')
  @ApiOperation({
    summary: 'Participantes (um por associado): inscrito, origem e data',
  })
  listarInscricoes(@Query() query: ListarInscricoesQuery) {
    return this.inscricoes.listar(query);
  }

  @Post('inscricoes/:userId/reverificar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consulta o SGA agora' })
  reverificarInscricao(@Param('userId', ParseIntPipe) userId: number) {
    return this.inscricoes.reverificar(userId);
  }

  @Put('inscricoes/:userId')
  @ApiOperation({
    summary: 'Marca a inscrição à mão (MANUAL, prevalece até ser desfeita)',
  })
  marcarInscricao(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: MarcarInscricaoDto,
    @Req() req: PanelRequest,
  ) {
    return this.inscricoes.marcar(userId, body, this.autor(req));
  }

  @Delete('inscricoes/:userId')
  @ApiOperation({ summary: 'Desfaz a marcação manual e volta a valer o SGA' })
  desfazerInscricao(
    @Param('userId', ParseIntPipe) userId: number,
    @Req() req: PanelRequest,
  ) {
    return this.inscricoes.desfazerMarcacao(userId, this.autor(req));
  }

  // ------------------------------------------------------------- notificações

  @Get('notificacoes')
  @ApiOperation({ summary: 'Notificações do painel (lidas/não lidas)' })
  listarNotificacoes(@Query() query: ListarNotificacoesQuery) {
    return this.notificacoesAdmin.listar(query);
  }

  @Get('notificacoes/nao-lidas')
  @ApiOperation({ summary: 'Contador de não lidas (menu)' })
  contarNotificacoes(@Query() query: BaseOpcionalQuery) {
    return this.notificacoesAdmin.contarNaoLidas(query.baseOrigin);
  }

  @Post('notificacoes/marcar-todas-lidas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca todas como lidas' })
  marcarTodasNotificacoes(
    @Query() query: BaseOpcionalQuery,
    @Req() req: PanelRequest,
  ) {
    return this.notificacoesAdmin.marcarTodas(
      this.autor(req),
      query.baseOrigin,
    );
  }

  @Post('notificacoes/:id/lida')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca uma notificação como lida' })
  marcarNotificacao(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: PanelRequest,
  ) {
    return this.notificacoesAdmin.marcarLida(id, this.autor(req));
  }

  // -------------------------------------------------------------- associados

  @Get('associados/:userId/raspadas')
  @ApiOperation({ summary: 'Histórico de raspadas do associado' })
  raspadasDoAssociado(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: PaginacaoQuery,
  ) {
    return this.raspadinha.historicoDoAssociado(userId, query);
  }

  @Get('associados/:userId/tentativas')
  @ApiOperation({
    summary: 'Tentativas que falharam ("tentou X e não conseguiu")',
  })
  tentativasDoAssociado(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: PaginacaoQuery,
  ) {
    return this.tentativas.listarDoAssociado(userId, query);
  }

  @Get('associados')
  @ApiOperation({ summary: 'Busca associados por nome ou CPF, com saldo' })
  buscarAssociados(@Query() query: BuscarAssociadosQuery) {
    return this.creditos.buscarAssociados(query);
  }

  @Get('associados/:userId/extrato')
  @ApiOperation({ summary: 'Extrato de créditos do associado' })
  extratoDoAssociado(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: PaginacaoQuery,
  ) {
    return this.creditos.extratoAdmin(userId, query);
  }

  @Post('associados/:userId/creditos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ajuste manual de créditos (motivo obrigatório)' })
  ajustarCreditos(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: AjusteCreditosDto,
    @Req() req: PanelRequest,
  ) {
    return this.creditos.ajustar(userId, body, this.autor(req));
  }

  /** Usuário do painel dono do JWT: fica registrado em ajustes e estornos. */
  private autor(req: PanelRequest): SorteAutor {
    const id = Number(req.user?.userId);
    return {
      id: Number.isInteger(id) ? id : null,
      nome: req.user?.username ?? req.user?.email ?? null,
    };
  }
}
