import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import { RastreamentoM7, AncoraM7Response } from './rastreamento-m7';
import {
  ultimaPosicaoLogica,
  UltimaPosicaoLogicaResponse,
} from './rastreamento.logica';
import {
  RastreamentoSoftruck,
  UltimaPosicaoSoftruckResponse,
} from './rastreamento-softruck';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class RastreamentoService {
  private m7: RastreamentoM7;
  private softruck: RastreamentoSoftruck;
  private readonly logger = new Logger(RastreamentoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.m7 = new RastreamentoM7();
    this.softruck = new RastreamentoSoftruck();
  }
  /**
   * Persiste evento de webhook M7 na base de dados
   * - Extrai chassi, evento, tipoevento de forma defensiva
   * - Salva payload completo para auditoria
   * - Nunca lança erro para não quebrar o fluxo do webhook
   */
  async saveM7WebhookEvent(payload: unknown): Promise<void> {
    try {
      let chassi = '';
      let evento: string | null = null;
      let tipoevento: number | null = null;

      if (payload && typeof payload === 'object') {
        if ('chassi' in payload && typeof payload['chassi'] === 'string') {
          chassi = payload['chassi'];
        }
        if ('evento' in payload && typeof payload['evento'] === 'string') {
          evento = payload['evento'];
        }
        if (
          'tipoevento' in payload &&
          (typeof payload['tipoevento'] === 'number' ||
            typeof payload['tipoevento'] === 'string')
        ) {
          const n = Number(payload['tipoevento']);
          tipoevento = isNaN(n) ? null : n;
        }
      }

      await this.prisma.vehicleWebhookEvent.create({
        data: {
          chassi,
          evento,
          tipoevento,
          provider: 'M7',
          payload: payload as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        'Erro ao salvar evento de webhook M7',
        err?.stack || err,
      );
      // Nunca lança erro para não quebrar o fluxo do webhook
    }
  }

  // Orquestrador: delega para o rastreador Lógica Soluções
  async ultimaPosicaoLogica(
    chassi: string,
  ): Promise<UltimaPosicaoLogicaResponse> {
    return ultimaPosicaoLogica(chassi);
  }

  // Orquestrador: delega para o rastreador M7
  async ultimaPosicaoM7(cnpj: string, chassi: string) {
    return this.m7.ultimaPosicaoM7(cnpj, chassi);
  }

  async ancoraM7(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
  ): Promise<AncoraM7Response> {
    const result = await this.m7.ancoraM7(cnpj, chassi, ancoraAtiva);

    // Persiste o estado da âncora somente em caso de sucesso
    if (!('erro' in result)) {
      try {
        const userVehicle = await this.prisma.userVehicle.findFirst({
          where: { chassi },
          select: { userId: true },
        });

        if (userVehicle) {
          await this.prisma.user.update({
            where: { id: userVehicle.userId },
            data: { ancoraAtiva },
          });
          this.logger.log(
            `Estado da âncora atualizado para userId=${userVehicle.userId}: ancoraAtiva=${ancoraAtiva}`,
          );
        } else {
          this.logger.warn(
            `Nenhum usuário encontrado para o chassi ${chassi} — estado da âncora não persistido`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Erro ao persistir estado da âncora para chassi=${chassi}`,
          err?.stack || err,
        );
      }
    }

    return result;
  }

  async getAncoraStatus(
    chassi: string,
  ): Promise<{ ancoraAtiva: boolean; userId: number | null }> {
    const userVehicle = await this.prisma.userVehicle.findFirst({
      where: { chassi },
      select: {
        userId: true,
        user: { select: { ancoraAtiva: true } },
      },
    });

    if (!userVehicle) {
      return { ancoraAtiva: false, userId: null };
    }

    return {
      ancoraAtiva: userVehicle.user.ancoraAtiva,
      userId: userVehicle.userId,
    };
  }

  async renovarTokenM7() {
    return this.m7.renovarToken();
  }

  // Orquestrador: delega para o rastreador Softruck
  async ultimaPosicaoSoftruck(
    chassi: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    this.logger.log(
      `Consultando última posição Softruck para chassi: ${chassi}`,
    );
    return this.softruck.ultimaPosicaoSoftruck(chassi);
  }

  // Orquestrador: delega para o processador de webhook M7
  async processarWebhookM7(payload: unknown) {
    // Salva o payload antes de processar
    await this.salvarPayloadWebhook(payload);
    await this.saveM7WebhookEvent(payload);

    // Disparar notificações push conforme tipo do evento
    await this.dispararNotificacaoPorEvento(payload);

    return this.m7.processarWebhook(payload);
  }

  /**
   * Extrai chassi/tipoevento/evento do payload e aciona o serviço de notificações.
   * Nunca lança erro para não interromper o processamento do webhook.
   */
  private async dispararNotificacaoPorEvento(payload: unknown): Promise<void> {
    try {
      if (!payload || typeof payload !== 'object') return;

      let chassi = '';
      let evento: string | null = null;
      let tipoevento: number | null = null;

      if ('chassi' in payload && typeof payload['chassi'] === 'string') {
        chassi = payload['chassi'];
      }
      if ('evento' in payload && typeof payload['evento'] === 'string') {
        evento = payload['evento'];
      }
      if ('tipoevento' in payload) {
        const n = Number(payload['tipoevento']);
        tipoevento = isNaN(n) ? null : n;
      }

      if (!chassi) {
        this.logger.warn('[Webhook] Payload sem chassi — notificação não disparada');
        return;
      }

      await this.notificationsService.dispararNotificacaoVeiculoWebhook(
        chassi,
        tipoevento,
        evento,
      );
    } catch (err) {
      this.logger.error(
        '[Webhook] Erro ao disparar notificação por evento',
        err?.stack || err,
      );
    }
  }

  /**
   * Salva o payload do webhook M7 em um arquivo JSON estruturado
   * Os arquivos são salvos em webhook/payloads com timestamp único
   * Usa operações assíncronas para não bloquear o event loop
   */
  private async salvarPayloadWebhook(payload: unknown): Promise<void> {
    try {
      // Define o caminho da pasta de payloads
      const payloadsDir = path.join(process.cwd(), 'webhook', 'payloads');

      // Cria a estrutura de diretórios se não existir
      await fs.mkdir(payloadsDir, { recursive: true });

      // Gera um nome único para o arquivo usando timestamp e ID aleatório
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const randomId = Math.random().toString(36).substring(2, 9);
      const filename = `webhook-m7-${timestamp}-${randomId}.json`;
      const filepath = path.join(payloadsDir, filename);

      // Estrutura o payload com metadados
      const payloadStructured = {
        receivedAt: new Date().toISOString(),
        type: 'M7_WEBHOOK',
        payload: payload,
      };

      // Salva o arquivo JSON formatado (assíncrono)
      await fs.writeFile(
        filepath,
        JSON.stringify(payloadStructured, null, 2),
        'utf-8',
      );

      this.logger.log(`[Webhook M7] Payload salvo em: ${filename}`);
    } catch (error) {
      // Não lança erro para não quebrar o fluxo do webhook
      this.logger.error('[Webhook M7] Erro ao salvar payload:', error);
    }
  }
}
