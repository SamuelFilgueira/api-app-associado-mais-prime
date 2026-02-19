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
import { UpdateAssociadoDto } from './DTOs/update-associado.dto';
import { PrimeiroAcessoDto } from './DTOs/primeiro-acesso.dto';

@Controller('associado')
export class AssociadoController {
  private readonly logger = new Logger(AssociadoController.name);

  constructor(private readonly associadoService: AssociadoService) {}

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

  @Patch(':id')
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
