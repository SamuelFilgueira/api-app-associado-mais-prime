import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import {
  RastreamentoM7,
  AncoraM7Response,
  EventoPadraoM7Response,
} from './rastreamento-m7';
import {
  ultimaPosicaoLogica,
  UltimaPosicaoLogicaResponse,
} from './rastreamento.logica';
import {
  RastreamentoSoftruck,
  UltimaPosicaoSoftruckResponse,
} from './rastreamento-softruck';
import { BaseOrigin, TokenResolverService } from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';
import { NotificationsService } from '../notifications/notifications.service';
import axios from 'axios';

type RastreamentoUnificadoResponse =
  | UltimaPosicaoLogicaResponse
  | Awaited<ReturnType<RastreamentoM7['ultimaPosicaoM7']>>
  | UltimaPosicaoSoftruckResponse;

interface RastreamentoCandidato {
  data: RastreamentoUnificadoResponse;
  dataOriginal: string;
  timestamp: number;
}

interface RastreamentoBaseContext {
  baseOrigin: BaseOrigin;
  logicaToken: string;
  logicaTokenKey: string;
  softruckPublicKey: string;
}

@Injectable()
export class RastreamentoService {
  private m7: RastreamentoM7;
  private softruck: RastreamentoSoftruck;
  private readonly logger = new Logger(RastreamentoService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly tokenResolver: TokenResolverService,
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
    token?: string,
    context?: { baseOrigin?: BaseOrigin; tokenKey?: string },
  ): Promise<UltimaPosicaoLogicaResponse> {
    return ultimaPosicaoLogica(chassi, token, context);
  }

  async rastreamento(
    cnpj: string,
    chassi: string,
    requestContext?: RastreamentoBaseContext,
  ): Promise<
    RastreamentoUnificadoResponse & { origem: 'm7' | 'logica' | 'softruck' }
  > {
    const candidatos: Array<{
      data: any;
      dataOriginal: string;
      timestamp: number;
      origem: 'm7' | 'logica' | 'softruck';
    }> = [];

    try {
      const baseContext =
        requestContext ?? (await this.resolveBaseContextFromDb(chassi));

      this.logger.log(
        `${baseTag(baseContext.baseOrigin)} usando token ${baseContext.logicaTokenKey} para consulta Lógica`,
      );

      const logica = await this.ultimaPosicaoLogica(chassi, baseContext.logicaToken, {
        baseOrigin: baseContext.baseOrigin,
        tokenKey: baseContext.logicaTokenKey,
      });
      const timestamp = this.parseDateToTimestamp(logica.ultimaTrasmissao);

      candidatos.push({
        data: logica,
        dataOriginal: logica.ultimaTrasmissao,
        timestamp,
        origem: 'logica',
      });
    } catch (error) {
      this.logger.warn(
        `Falha no rastreamento Lógica para chassi ${chassi}: ${this.descreverErroProvider(error)}`,
      );
    }

    try {
      const baseContext =
        requestContext ?? (await this.resolveBaseContextFromDb(chassi));
      const m7 = await this.ultimaPosicaoM7(cnpj, chassi, baseContext.baseOrigin);
      const timestamp = this.parseDateToTimestamp(m7.data_gps);

      candidatos.push({
        data: m7,
        dataOriginal: m7.data_gps,
        timestamp,
        origem: 'm7',
      });
    } catch (error) {
      this.logger.warn(
        `Falha no rastreamento M7 para chassi ${chassi}: ${this.descreverErroProvider(error)}`,
      );
    }

    try {
      const baseContext =
        requestContext ?? (await this.resolveBaseContextFromDb(chassi));
      const softruckPublicKeyKey = this.tokenResolver.getTokenKey(
        baseContext.baseOrigin,
        'softruckPublicKey',
      );

      this.logger.log(
        `${baseTag(baseContext.baseOrigin)} usando publicKey ${softruckPublicKeyKey} para consulta Softruck (token via autenticação dinâmica)`,
      );

      const softruck = await this.ultimaPosicaoSoftruck(
        chassi,
        baseContext.baseOrigin,
        baseContext.softruckPublicKey,
      );
      const timestamp = this.parseDateToTimestamp(softruck.date);

      candidatos.push({
        data: softruck,
        dataOriginal: softruck.date,
        timestamp,
        origem: 'softruck',
      });
    } catch (error) {
      this.logger.warn(
        `Falha no rastreamento Softruck para chassi ${chassi}: ${this.descreverErroProvider(error)}`,
      );
    }

    if (candidatos.length === 0) {
      throw new Error('Nenhum provedor de rastreamento retornou dados válidos');
    }

    const maisRecente = candidatos.reduce((atualMaisRecente, candidato) =>
      candidato.timestamp > atualMaisRecente.timestamp
        ? candidato
        : atualMaisRecente,
    );

    this.logger.log(
      `Rastreamento unificado retornando registro mais recente em ${maisRecente.dataOriginal} (${maisRecente.origem})`,
    );

    // 🔥 Aqui está o pulo do gato
    return {
      ...maisRecente.data,
      origem: maisRecente.origem,
    };
  }
  // Orquestrador: delega para o rastreador M7
  async ultimaPosicaoM7(cnpj: string, chassi: string, baseOrigin: BaseOrigin) {
    return this.m7.ultimaPosicaoM7(cnpj, chassi, baseOrigin);
  }

  /**
   * Orquestrador: gera PDF do histórico M7.
   * Toda validação de entrada é centralizada aqui para manter o controller enxuto.
   */
  async gerarRelatorioHistoricoM7PDF(
    dataInicial: string,
    dataFinal: string,
    placa: string,
    baseOrigin: BaseOrigin,
  ): Promise<Buffer> {
    const placaNormalizada = placa?.trim()?.toUpperCase();
    const dataInicialNormalizada = dataInicial?.trim();
    const dataFinalNormalizada = dataFinal?.trim();

    if (!placaNormalizada) {
      throw new BadRequestException('Parâmetro placa é obrigatório');
    }

    if (!this.isDataIsoValida(dataInicialNormalizada)) {
      throw new BadRequestException(
        'Parâmetro dataInicial inválido. Use o formato yyyy-mm-dd',
      );
    }

    if (!this.isDataIsoValida(dataFinalNormalizada)) {
      throw new BadRequestException(
        'Parâmetro dataFinal inválido. Use o formato yyyy-mm-dd',
      );
    }

    if (dataInicialNormalizada > dataFinalNormalizada) {
      throw new BadRequestException(
        'Parâmetro dataInicial não pode ser maior que dataFinal',
      );
    }

    return this.m7.gerarRelatorioHistoricoPDFPorBase(
      dataInicialNormalizada,
      dataFinalNormalizada,
      placaNormalizada,
      baseOrigin,
    );
  }

  

  /**
   * Obtém o estado atual do veículo (ancoraAtiva + notificacaoIgnicao).
   * Prioriza o banco; se não encontrado, consulta o endpoint de evento-padrão da API M7.
   */
  private async getVehicleState(
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin = 'MAIS_PRIME',
  ): Promise<{ ancoraAtiva: boolean; notificacaoIgnicao: boolean }> {
    const userVehicle = await this.prisma.userVehicle.findFirst({
      where: { chassi },
      select: {
        user: { select: { ancoraAtiva: true, notificacaoIgnicao: true } },
      },
    });

    if (userVehicle?.user) {
      return {
        ancoraAtiva: userVehicle.user.ancoraAtiva,
        notificacaoIgnicao: userVehicle.user.notificacaoIgnicao,
      };
    }

    this.logger.warn(
      `Estado do veículo não encontrado no banco para chassi=${chassi} — consultando API M7`,
    );
    const estadoM7: EventoPadraoM7Response = await this.m7.getEventoPadraoM7(
      cnpj,
      chassi,
      baseOrigin,
    );
    return {
      ancoraAtiva: estadoM7.ancoraAtiva,
      notificacaoIgnicao: estadoM7.evtIgn,
    };
  }

  async ancoraM7(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    // Preserva o estado de ignição atual para evitar reset acidental
    const estado = await this.getVehicleState(cnpj, chassi, baseOrigin);
    const result = await this.m7.ancoraM7(
      cnpj,
      chassi,
      ancoraAtiva,
      estado.notificacaoIgnicao,
      baseOrigin,
    );

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

  async ignicaoM7(
    cnpj: string,
    chassi: string,
    evtIgn: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    const evtIgnNormalizado = this.normalizarBooleanoEntrada(evtIgn, 'evt_ign');

    // Preserva o estado da âncora atual para evitar reset acidental
    const estado = await this.getVehicleState(cnpj, chassi, baseOrigin);

    // if (evtIgnNormalizado && estado.ancoraAtiva) {
    //   this.logger.warn(
    //     `Tentativa inválida de ativar ignição com âncora ativa para chassi=${chassi}`,
    //   );
    //   throw new BadRequestException(
    //     'Não é permitido ligar ignição com âncora ativa',
    //   );
    // }

    const result = await this.m7.ignicaoM7(
      cnpj,
      chassi,
      evtIgnNormalizado,
      estado.ancoraAtiva,
      baseOrigin,
    );

    if (!('erro' in result)) {
      try {
        const userVehicle = await this.prisma.userVehicle.findFirst({
          where: { chassi },
          select: { userId: true },
        });

        if (userVehicle) {
          await this.prisma.user.update({
            where: { id: userVehicle.userId },
            data: { notificacaoIgnicao: evtIgnNormalizado },
          });
          this.logger.log(
            `Estado de ignição atualizado para userId=${userVehicle.userId}: notificacaoIgnicao=${evtIgnNormalizado}`,
          );
        } else {
          this.logger.warn(
            `Nenhum usuário encontrado para o chassi ${chassi} — estado de ignição não persistido`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Erro ao persistir estado de ignição para chassi=${chassi}`,
          err?.stack || err,
        );
      }
    }

    return result;
  }

  async getIgnicaoStatus(
    chassi: string,
  ): Promise<{ notificacaoIgnicao: boolean; userId: number | null }> {
    const normalizedChassi = chassi?.trim();

    if (!normalizedChassi) {
      throw new BadRequestException('Chassi é obrigatório');
    }

    const userVehicle = await this.prisma.userVehicle.findFirst({
      where: {
        chassi: normalizedChassi,
        isActive: true,
        user: { isActive: true },
      },
      select: {
        userId: true,
        user: { select: { notificacaoIgnicao: true } },
      },
    });

    if (!userVehicle) {
      return { notificacaoIgnicao: false, userId: null };
    }

    return {
      notificacaoIgnicao: userVehicle.user.notificacaoIgnicao,
      userId: userVehicle.userId,
    };
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
    const [mp, mprs] = await Promise.allSettled([
      this.m7.renovarToken('MAIS_PRIME'),
      this.m7.renovarToken('MAIS_PRIME_RS'),
    ]);
    return {
      MAIS_PRIME: mp.status === 'fulfilled' ? mp.value : { erro: (mp as PromiseRejectedResult).reason?.message },
      MAIS_PRIME_RS: mprs.status === 'fulfilled' ? mprs.value : { erro: (mprs as PromiseRejectedResult).reason?.message },
    };
  }

  private normalizarBooleanoEntrada(
    value: unknown,
    fieldName: string,
  ): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }

    throw new BadRequestException(
      `Campo ${fieldName} inválido. Use true/false ou 1/0.`,
    );
  }

  /** Valida formato yyyy-mm-dd com data real de calendário. */
  private isDataIsoValida(value?: string): boolean {
    if (!value) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  // Orquestrador: delega para o rastreador Softruck
  async ultimaPosicaoSoftruck(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
    tokenOverride?: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    this.logger.log(
      `${baseTag(baseOrigin)} Consultando última posição Softruck para chassi: ${chassi} (tokenOverride=${!!tokenOverride})`,
    );
    return this.softruck.ultimaPosicaoSoftruck(
      chassi,
      baseOrigin,
      publicKey,
      tokenOverride,
    );
  }

  private async resolveBaseContextFromDb(
    chassi: string,
  ): Promise<RastreamentoBaseContext> {
    let baseOrigin: BaseOrigin = 'MAIS_PRIME';

    try {
      const userVehicle = await this.prisma.userVehicle.findFirst({
        where: { chassi },
        select: { user: { select: { baseOrigin: true } } },
      });
      if (userVehicle?.user?.baseOrigin) {
        baseOrigin = userVehicle.user.baseOrigin as BaseOrigin;
      }
    } catch (err) {
      this.logger.warn(
        `Falha ao buscar baseOrigin no DB para chassi=${chassi}: ${err?.message}`,
      );
    }

    return {
      baseOrigin,
      logicaToken: this.tokenResolver.resolveLogicaToken(baseOrigin),
      logicaTokenKey: this.tokenResolver.getTokenKey(baseOrigin, 'logica'),
      softruckPublicKey: this.tokenResolver.resolveSoftruckPublicKey(baseOrigin),
    };
  }

  private descreverErroProvider(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return `HTTP ${error.response?.status ?? 'N/A'} | URL: ${error.config?.url ?? 'N/A'} | Body: ${JSON.stringify(error.response?.data ?? null)}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
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

  private parseDateToTimestamp(dateValue: string): number {
    const dateTrimmed = dateValue.trim();

    const parsedNative = Date.parse(dateTrimmed.replace(' ', 'T'));
    if (!Number.isNaN(parsedNative)) {
      return parsedNative;
    }

    const brDateMatch = dateTrimmed.match(
      /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );

    if (brDateMatch) {
      const [, day, month, year, hour, minute, second] = brDateMatch;
      const parsed = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second ?? '0'),
      ).getTime();

      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    throw new Error(`Formato de data inválido: ${dateValue}`);
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
        this.logger.warn(
          '[Webhook] Payload sem chassi — notificação não disparada',
        );
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
