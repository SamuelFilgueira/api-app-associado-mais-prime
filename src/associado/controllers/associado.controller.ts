import { UseGuards, Request, Logger } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
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
import { AssociadoService } from 'src/associado/services/associado.service';
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

  @Post('primeiro-acesso')
  async primeiroAcesso(@Body() data: PrimeiroAcessoDto) {
    return this.associadoService.primeiroAcesso(data.cpf);
  }

  @Get('cpf')
  async findByCpf(@Query('cpf') cpf: string) {
    const resposta = await this.associadoService.findByCpf(cpf);
    return resposta;
  }

  @Get(':id')
  async findById(@Param('id', ParseIntPipe) id: number) {
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
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/password')
  async changePassword(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @Body() body: { newPassword: string },
  ) {
    return this.associadoService.changePassword(id, body.newPassword);
  }
}
