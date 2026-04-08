import { UseGuards, Request, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AssociadoService } from './associado.service';
import { BaseContextService } from 'src/shared/base-context.service';
import { UpdateAssociadoDto } from './DTOs/update-associado.dto';
import { PrimeiroAcessoDto } from './DTOs/primeiro-acesso.dto';

@Controller('associado')
export class AssociadoController {
  private readonly logger = new Logger(AssociadoController.name);

  constructor(
    private readonly associadoService: AssociadoService,
    private readonly baseContextService: BaseContextService,
  ) {}

  @Post('primeiro-acesso')
  async primeiroAcesso(@Body() data: PrimeiroAcessoDto) {
    this.logger.log(
      `Dados recebido no primeiro acesso: ${JSON.stringify(data)}`,
    );
    return this.associadoService.primeiroAcesso(data.cpf);
  }

  @Get(':id')
  async findById(@Param('id', ParseIntPipe) id: number) {
    this.logger.log(`Buscando associado com ID: ${id}`);
    const resposta = await this.associadoService.findById(id);
    return resposta;
  }

  // @Get('base-origin/:cpf')
  // async findBaseOriginByCpf(@Param('cpf') cpf: string) {
  //   return this.associadoService.findBaseOriginByCpf(cpf);
  // }

  @Get('verificar-situacao/:cpf')
  async verificarSituacao(@Param('cpf') cpf: string) {
    return this.associadoService.verificarSituacao(cpf);
  }

  @Get('cpf/:cpf/veiculos')
  @UseGuards(JwtAuthGuard)
  async findVehiclesByCpf(@Param('cpf') cpf: string) {
    this.logger.log(`Buscando veículos do associado pelo CPF: ${cpf}`);
    // Exemplo de uso de BaseContextService em rota autenticada
    try {
      const sgaToken = this.baseContextService.getSgaToken();
      this.logger.log(`SGA token disponível para request autenticada (hash): ${sgaToken?.slice?.(0, 8) ?? 'n/a'}`);
    } catch (err) {
      this.logger.error(`Erro ao obter token via BaseContextService: ${err?.message}`);
    }
    return this.associadoService.findVehiclesByCpf(cpf);
  }

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
   * Rota para troca de senha do usuário autenticado
   * PATCH /associado/password
   * Body: { newPassword: string }
   * Header: Authorization: Bearer <token>
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/password')
  async changePassword(@Request() req, @Body() body: { newPassword: string }) {
    const userId = req.user.userId as number;
    return this.associadoService.changePassword(userId, body.newPassword);
  }
}
