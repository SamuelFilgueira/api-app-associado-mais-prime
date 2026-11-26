import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { AdminPanelRoles } from 'src/infra/decorators/admin-panel-roles.decorator';
import { AdminPanelRole } from 'src/infra/enums/admin-panel-role.enum';
import { AdminPanelRoleGuard } from 'src/infra/guards/admin-panel-role.guard';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { FILAS } from 'src/queue/filas';

/**
 * Operação das filas pelo painel, restrita ao perfil ADMIN:
 *
 * - `GET  /api/admin/filas` — jobs por fila e estado, e mortos por fila;
 * - `GET  /api/admin/filas/mortos?fila=&limite=` — jobs na fila de mortos;
 * - `POST /api/admin/filas/mortos/:id/reprocessar` — devolve o job à fila de
 *   origem;
 * - `DELETE /api/admin/filas/mortos/:id` — descarta.
 */
@Controller('admin/filas')
@UseGuards(JwtAuthGuard, AdminPanelRoleGuard)
@AdminPanelRoles(AdminPanelRole.ADMIN)
export class FilasAdminController {
  constructor(
    private readonly filaDeMortos: FilaDeMortosService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get()
  async resumo() {
    const mortos = await this.filaDeMortos.contarPorFila();
    const filas = await Promise.all(
      FILAS.map(async (nome) => {
        const fila = this.moduleRef.get<Queue>(getQueueToken(nome), {
          strict: false,
        });
        return {
          fila: nome,
          ...(await fila.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
          )),
          mortos: mortos[nome] ?? 0,
        };
      }),
    );
    return { filas };
  }

  @Get('mortos')
  listarMortos(@Query('fila') fila?: string, @Query('limite') limite?: string) {
    return this.filaDeMortos.listar({
      fila: fila || undefined,
      limite: limite ? Number(limite) : undefined,
    });
  }

  @Post('mortos/:id/reprocessar')
  @HttpCode(200)
  async reprocessar(@Param('id') id: string) {
    try {
      return await this.filaDeMortos.reprocessar(id);
    } catch (erro) {
      throw new NotFoundException(
        erro instanceof Error ? erro.message : 'Job não encontrado',
      );
    }
  }

  @Delete('mortos/:id')
  @HttpCode(204)
  async descartar(@Param('id') id: string): Promise<void> {
    try {
      await this.filaDeMortos.descartar(id);
    } catch (erro) {
      throw new NotFoundException(
        erro instanceof Error ? erro.message : 'Job não encontrado',
      );
    }
  }
}
