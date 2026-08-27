import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AdminRoleGuard } from 'src/auth/guards/admin-role.guard';
import { PrismaService } from 'src/database/prisma.service';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { parseDateBR } from 'src/shared/date.util';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import {
  diasEfetivosDoMes,
  mascararCpf,
} from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';
import {
  BoletoNotificacaoService,
  JOB_EXECUTAR_ROTINA,
} from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoSchedulerService } from 'src/boleto-notificacao/services/boleto-notificacao-scheduler.service';
import { ExecutarRotinaDto } from 'src/boleto-notificacao/dto/executar-rotina.dto';

/**
 * Endpoints administrativos da rotina de notificações de boleto.
 * Acesso restrito a usuários com role ADMIN.
 */
@Controller('boleto-notificacao/admin')
@UseGuards(JwtAuthGuard, AdminRoleGuard)
export class BoletoNotificacaoAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: BoletoNotificacaoConfigService,
    private readonly notificacaoService: BoletoNotificacaoService,
    private readonly receiptsService: BoletoNotificacaoReceiptsService,
    private readonly schedulerService: BoletoNotificacaoSchedulerService,
    @InjectQueue(BOLETO_NOTIFICACAO_QUEUE) private readonly queue: Queue,
  ) {}

  /** Configuração efetiva + estado do agendamento + dias de gatilho do mês atual. */
  @Get('config')
  async getConfig() {
    const config = this.configService.get();
    const hoje = new Date();
    const agendamento = await this.schedulerService.statusAgendamento();
    return {
      ...config,
      sgaMockFile: config.sgaMockFile ?? null,
      agendamento,
      diasEfetivosMesAtual: diasEfetivosDoMes(
        hoje.getFullYear(),
        hoje.getMonth() + 1,
        config,
      ),
      diasEfetivosFevereiro: diasEfetivosDoMes(hoje.getFullYear(), 2, config),
    };
  }

  /** Datas-alvo e gatilhos para uma data de referência (default: hoje). */
  @Get('simular-datas')
  simularDatas(@Query('dataReferencia') dataReferencia?: string) {
    const data = this.parseDataReferencia(dataReferencia);
    return {
      dataReferencia: dataReferencia ?? 'hoje',
      momentos: this.notificacaoService.simularDatas(data),
    };
  }

  /**
   * Dispara a rotina manualmente. `sync=true` executa inline e devolve o
   * resultado (ideal para dev/homologação); caso contrário enfileira no BullMQ.
   */
  @Post('executar')
  @HttpCode(HttpStatus.OK)
  async executar(@Body() dto: ExecutarRotinaDto) {
    const dataReferencia = this.parseDataReferencia(dto.dataReferencia);

    if (dto.sync) {
      const resultados = await this.notificacaoService.executarRotina({
        origem: 'MANUAL',
        dataReferencia,
        tenants: dto.tenants,
        tipos: dto.tipos,
        dryRun: dto.dryRun === true,
      });
      return { executadoEm: 'sync', resultados };
    }

    const job = await this.queue.add(
      JOB_EXECUTAR_ROTINA,
      {
        origem: 'MANUAL',
        dataReferencia: dto.dataReferencia,
        tenants: dto.tenants,
        tipos: dto.tipos,
        dryRun: dto.dryRun === true,
      },
      { removeOnComplete: 30, removeOnFail: 30 },
    );

    return {
      executadoEm: 'queue',
      jobId: job.id,
      queue: BOLETO_NOTIFICACAO_QUEUE,
    };
  }

  /** Execuções recentes com métricas de cobertura. */
  @Get('execucoes')
  async listarExecucoes(
    @Query('limit') limit?: string,
    @Query('tenant') tenant?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const execucoes = await this.prisma.boletoNotificacaoExecucao.findMany({
      where: tenant ? { tenant } : undefined,
      orderBy: { iniciadoEm: 'desc' },
      take,
    });
    return { total: execucoes.length, execucoes };
  }

  /** Detalhe de uma execução + resumo de logs por status. */
  @Get('execucoes/:id')
  async detalheExecucao(@Param('id', ParseIntPipe) id: number) {
    const execucao = await this.prisma.boletoNotificacaoExecucao.findUnique({
      where: { id },
    });
    if (!execucao)
      throw new NotFoundException(`Execução #${id} não encontrada`);

    const porStatus = await this.prisma.boletoNotificacaoLog.groupBy({
      by: ['statusEnvio'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    return {
      execucao,
      logsPorStatus: Object.fromEntries(
        porStatus.map((p) => [p.statusEnvio, p._count._all]),
      ),
    };
  }

  /** Logs de disparo de uma execução (CPF mascarado). */
  @Get('execucoes/:id/logs')
  async logsExecucao(
    @Param('id', ParseIntPipe) id: number,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const logs = await this.prisma.boletoNotificacaoLog.findMany({
      where: {
        execucaoId: id,
        ...(status ? { statusEnvio: status as any } : {}),
      },
      orderBy: { id: 'asc' },
      take,
    });
    return {
      total: logs.length,
      logs: logs.map((log) => ({
        ...log,
        cpf: mascararCpf(log.cpf),
        expoPushToken: log.expoPushToken
          ? `${log.expoPushToken.slice(0, 18)}...`
          : null,
      })),
    };
  }

  /** Força a verificação de receipts de uma execução (sem esperar o job). */
  @Post('execucoes/:id/verificar-receipts')
  @HttpCode(HttpStatus.OK)
  async verificarReceipts(@Param('id', ParseIntPipe) id: number) {
    return this.receiptsService.verificarExecucao(id);
  }

  /** Re-sincroniza o agendamento no Redis com a configuração atual. */
  @Post('agendamento/sincronizar')
  @HttpCode(HttpStatus.OK)
  async sincronizarAgendamento() {
    await this.schedulerService.sincronizarAgendamento();
    return this.schedulerService.statusAgendamento();
  }

  private parseDataReferencia(valor?: string): Date {
    if (!valor) return new Date();
    const data = parseDateBR(valor);
    if (!data) {
      throw new BadRequestException(
        `dataReferencia inválida: "${valor}" (esperado dd/mm/yyyy)`,
      );
    }
    return data;
  }
}
