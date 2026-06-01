import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  RastreamentoM7,
  AncoraM7Response,
  EventoPadraoM7Response,
} from './rastreamento-m7';
import {
  LogicaRastreamentoService,
  UltimaPosicaoLogicaResponse,
} from './rastreamento.logica';
import {
  RastreamentoSoftruck,
  UltimaPosicaoSoftruckResponse,
} from './softruck/rastreamento-softruck.service';
import { BaseOrigin, TokenResolverService } from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';
import { NotificationsService } from '../notifications/notifications.service';
import { HistoricoSoftruckService } from './softruck/services/historico-softruck.service';
import { HistoricoRotasResponseDto } from './softruck/dto/historico-response.dto';
import axios from 'axios';

const DEFAULT_LOGICA_STALE_THRESHOLD_MINUTES = 20;

type RastreamentoUnificadoResponse =
  | UltimaPosicaoLogicaResponse
  | Awaited<ReturnType<RastreamentoM7['ultimaPosicaoM7']>>
  | UltimaPosicaoSoftruckResponse;

type RastreamentoUnificadoControllerResponse = Record<string, unknown> & {
  origem: 'm7' | 'logica' | 'softruck';
};

interface RastreamentoCandidato {
  data: RastreamentoUnificadoResponse;
  dataOriginal: string;
  timestamp: number;
  origem: 'm7' | 'logica' | 'softruck';
}

interface RastreamentoBaseContext {
  baseOrigin: BaseOrigin;
  logicaToken: string;
  logicaTokenKey: string;
  softruckPublicKey: string;
}

interface WebhookDados {
  chassi: string;
  evento: string | null;
  tipoevento: number | null;
  scope: string | null;
}

@Injectable()
export class RastreamentoService {
  private readonly logger = new Logger(RastreamentoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly tokenResolver: TokenResolverService,
    private readonly softruck: RastreamentoSoftruck,
    private readonly m7: RastreamentoM7,
    private readonly logica: LogicaRastreamentoService,
    private readonly historicoSoftruck: HistoricoSoftruckService,
  ) {}

  /**
   * Persiste evento de webhook M7 na base de dados.
   * Nunca lança erro para não quebrar o fluxo do webhook.
   */
  async saveM7WebhookEvent(payload: unknown): Promise<void> {
    try {
      const { chassi, evento, tipoevento, scope } = this.extrairDadosWebhook(payload);

      if (scope !== 'cliente') {
        this.logger.log(
          `Webhook M7 ignorado para persistência por scope=${scope ?? 'null'} (chassi=${chassi || 'N/A'})`,
        );
        return;
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
      this.logger.error('Erro ao salvar evento de webhook M7', err?.stack || err);
    }
  }

  async ultimaPosicaoLogica(
    chassi: string,
    token?: string,
    context?: { baseOrigin?: BaseOrigin; tokenKey?: string },
  ): Promise<UltimaPosicaoLogicaResponse> {
    return this.logica.ultimaPosicao(chassi, token, context);
  }

  async rastreamento(
    cnpj: string,
    chassi: string,
    requestContext?: RastreamentoBaseContext,
  ): Promise<RastreamentoUnificadoControllerResponse> {
    const baseContext =
      requestContext ?? (await this.resolveBaseContextFromDb(chassi));


    const softruckPublicKeyKey = this.tokenResolver.getTokenKey(
      baseContext.baseOrigin,
      'softruckPublicKey',
    );
    this.logger.log(
      `${baseTag(baseContext.baseOrigin)} usando publicKey ${softruckPublicKeyKey} para consulta Softruck (token via autenticação dinâmica)`,
    );

    const [logicaResult, m7Result, softruckResult] = await Promise.allSettled([
      this.logica.ultimaPosicao(chassi, baseContext.logicaToken, {
        baseOrigin: baseContext.baseOrigin,
        tokenKey: baseContext.logicaTokenKey,
      }),
      this.m7.ultimaPosicaoM7(cnpj, chassi, baseContext.baseOrigin),
      this.softruck.ultimaPosicaoSoftruck(
        chassi,
        baseContext.baseOrigin,
        baseContext.softruckPublicKey,
      ),
    ]);

    const candidatos: RastreamentoCandidato[] = [];

    if (logicaResult.status === 'fulfilled') {
      const logica = logicaResult.value;
      candidatos.push({
        data: logica,
        dataOriginal: logica.ultimaTrasmissao,
        timestamp: this.parseDateToTimestamp(logica.ultimaTrasmissao),
        origem: 'logica',
      });
    } else {
      this.logger.warn(
        `Falha no rastreamento Lógica para chassi ${chassi}: ${this.descreverErroProvider(logicaResult.reason)}`,
      );
    }

    if (m7Result.status === 'fulfilled') {
      const m7 = m7Result.value;
      candidatos.push({
        data: m7,
        dataOriginal: m7.data_gps,
        timestamp: this.parseDateToTimestamp(m7.data_gps),
        origem: 'm7',
      });
    } else {
      this.logger.warn(
        `Falha no rastreamento M7 para chassi ${chassi}: ${this.descreverErroProvider(m7Result.reason)}`,
      );
    }

    if (softruckResult.status === 'fulfilled') {
      const softruck = softruckResult.value;
      candidatos.push({
        data: softruck,
        dataOriginal: softruck.date,
        timestamp: this.parseDateToTimestamp(softruck.date),
        origem: 'softruck',
      });
    } else {
      this.logger.warn(
        `Falha no rastreamento Softruck para chassi ${chassi}: ${this.descreverErroProvider(softruckResult.reason)}`,
      );
    }

    if (candidatos.length === 0) {
      throw new Error('Nenhum provedor de rastreamento retornou dados válidos');
    }

    const maisRecente = candidatos.reduce((atualMaisRecente, candidato) =>
      candidato.timestamp > atualMaisRecente.timestamp ? candidato : atualMaisRecente,
    );

    const candidatoLogica = candidatos.find((c) => c.origem === 'logica');

    let selecionado = maisRecente;
    if (candidatoLogica) {
      selecionado = candidatoLogica;

      if (
        maisRecente.origem !== 'logica' &&
        this.deveUsarFallbackPorDefasagemLogica(candidatoLogica, maisRecente)
      ) {
        selecionado = maisRecente;
      }
    }

    const payload = this.normalizarRespostaRastreamento(
      selecionado.data,
      selecionado.origem,
    );

    return { ...payload, origem: selecionado.origem };
  }

  async ultimaPosicaoM7(cnpj: string, chassi: string, baseOrigin: BaseOrigin) {
    return this.m7.ultimaPosicaoM7(cnpj, chassi, baseOrigin);
  }

  /**
   * Gera PDF de histórico de trajetórias via API Softruck.
   */
  async gerarRelatorioHistoricoSoftruckPDF(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<Buffer> {
    const chassiNormalizado = chassi?.trim();
    const dataInicialNormalizada = dataInicial?.trim();
    const dataFinalNormalizada = dataFinal?.trim();

    this.validarParametrosHistorico(chassiNormalizado, dataInicialNormalizada, dataFinalNormalizada);

    return this.historicoSoftruck.gerarRelatorioPdf(
      chassiNormalizado,
      dataInicialNormalizada,
      dataFinalNormalizada,
      baseOrigin,
      publicKey,
    );
  }

  /**
   * Retorna rotas detalhadas em GeoJSON para o período via API Softruck.
   */
  async obterRotasHistoricoSoftruck(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<HistoricoRotasResponseDto> {
    const chassiNormalizado = chassi?.trim();
    const dataInicialNormalizada = dataInicial?.trim();
    const dataFinalNormalizada = dataFinal?.trim();

    this.validarParametrosHistorico(chassiNormalizado, dataInicialNormalizada, dataFinalNormalizada);

    return this.historicoSoftruck.obterRotas(
      chassiNormalizado,
      dataInicialNormalizada,
      dataFinalNormalizada,
      baseOrigin,
      publicKey,
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
    const estado = await this.getVehicleState(cnpj, chassi, baseOrigin);

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

  async ultimaPosicaoSoftruck(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
    tokenOverride?: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    this.logger.log(
      `${baseTag(baseOrigin)} Consultando última posição Softruck para chassi: ${chassi} (tokenOverride=${!!tokenOverride})`,
    );
    return this.softruck.ultimaPosicaoSoftruck(chassi, baseOrigin, publicKey, tokenOverride);
  }

  async processarWebhookM7(payload: unknown) {
    await this.saveM7WebhookEvent(payload);
    await this.dispararNotificacaoPorEvento(payload);
    return this.m7.processarWebhook(payload);
  }

  // -------------------------------------------------------------------------
  // Privados
  // -------------------------------------------------------------------------

  /**
   * Extrai chassi, evento e tipoevento do payload de webhook.
   * Centraliza a lógica que antes estava duplicada em saveM7WebhookEvent e dispararNotificacaoPorEvento.
   */
  private extrairDadosWebhook(payload: unknown): WebhookDados {
    if (!payload || typeof payload !== 'object') {
      return { chassi: '', evento: null, tipoevento: null, scope: null };
    }
    const p = payload as Record<string, unknown>;
    const chassi = typeof p['chassi'] === 'string' ? p['chassi'] : '';
    const evento = typeof p['evento'] === 'string' ? p['evento'] : null;
    const raw = Number(p['tipoevento']);
    const scope = typeof p['scope'] === 'string' ? p['scope'].trim().toLowerCase() : null;
    return { chassi, evento, tipoevento: isNaN(raw) ? null : raw, scope };
  }

  /**
   * Valida chassi + intervalo de datas para endpoints de histórico.
   * Lança BadRequestException em caso de parâmetros inválidos.
   */
  private validarParametrosHistorico(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
  ): void {
    if (!chassi) {
      throw new BadRequestException('Parâmetro chassi é obrigatório');
    }
    if (!this.isDataIsoValida(dataInicial)) {
      throw new BadRequestException('Parâmetro dataInicial inválido. Use o formato yyyy-mm-dd');
    }
    if (!this.isDataIsoValida(dataFinal)) {
      throw new BadRequestException('Parâmetro dataFinal inválido. Use o formato yyyy-mm-dd');
    }
    if (dataInicial > dataFinal) {
      throw new BadRequestException('Parâmetro dataInicial não pode ser maior que dataFinal');
    }
  }

  private normalizarBooleanoEntrada(value: unknown, fieldName: string): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
    throw new BadRequestException(`Campo ${fieldName} inválido. Use true/false ou 1/0.`);
  }

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

  private async resolveBaseContextFromDb(chassi: string): Promise<RastreamentoBaseContext> {
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
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private parseDateToTimestamp(dateValue: string): number {
    const dateTrimmed = dateValue.trim();

    const parsedNative = Date.parse(dateTrimmed.replace(' ', 'T'));
    if (!Number.isNaN(parsedNative)) return parsedNative;

    const brDateMatch = dateTrimmed.match(
      /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );

    if (brDateMatch) {
      const [, day, month, year, hour, minute, second] = brDateMatch;
      const parsed = new Date(
        Number(year), Number(month) - 1, Number(day),
        Number(hour), Number(minute), Number(second ?? '0'),
      ).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }

    throw new Error(`Formato de data inválido: ${dateValue}`);
  }

  private normalizarRespostaRastreamento(
    data: RastreamentoUnificadoResponse,
    origem: 'm7' | 'logica' | 'softruck',
  ): Record<string, unknown> {
    if (origem === 'softruck') {
      const softruck = data as UltimaPosicaoSoftruckResponse;

      return {
        ...softruck,
        placa: softruck.plate,
        marca: softruck.brandName,
        modelo: softruck.modelName,
        ultimaTrasmissao: softruck.date,
        data_gps: softruck.date,
        velocidade: softruck.speed,
        ignicao: softruck.ign ?? false,
        condutorNome: null,
        alertaIgnicao: false,
        cidade: null,
        endereco: null,
        bairro: null,
        estado: null,
        direcao: null,
        hodometro: null,
        voltagem: null,
        identificador: softruck.plate,
      };
    }

    return data as unknown as Record<string, unknown>;
  }

  private deveUsarFallbackPorDefasagemLogica(
    candidatoLogica: { timestamp: number; dataOriginal: string },
    candidatoMaisRecente: {
      timestamp: number;
      dataOriginal: string;
      origem: 'm7' | 'softruck' | 'logica';
    },
  ): boolean {
    if (candidatoMaisRecente.origem === 'logica') return false;

    const thresholdMs = this.getLogicaStaleThresholdMs();
    const diferencaMs = candidatoMaisRecente.timestamp - candidatoLogica.timestamp;

    if (diferencaMs < thresholdMs) {
      this.logger.log(
        `Lógica priorizada: diferença de recência (${Math.round(diferencaMs / 60000)} min) abaixo do limite (${Math.round(thresholdMs / 60000)} min)`,
      );
      return false;
    }

    this.logger.warn(
      `Fallback por defasagem da Lógica: lógica=${candidatoLogica.dataOriginal} provedor=${candidatoMaisRecente.origem} data=${candidatoMaisRecente.dataOriginal} diferença=${Math.round(diferencaMs / 60000)} min limite=${Math.round(thresholdMs / 60000)} min`,
    );
    return true;
  }

  private getLogicaStaleThresholdMs(): number {
    const rawValue = process.env.RASTREAMENTO_LOGICA_STALE_THRESHOLD_MINUTES;
    const parsedMinutes = Number(rawValue);

    if (Number.isFinite(parsedMinutes) && parsedMinutes > 0) {
      return parsedMinutes * 60_000;
    }

    return DEFAULT_LOGICA_STALE_THRESHOLD_MINUTES * 60_000;
  }

  /**
   * Extrai chassi/tipoevento/evento do payload e aciona o serviço de notificações.
   * Nunca lança erro para não interromper o processamento do webhook.
   */
  private async dispararNotificacaoPorEvento(payload: unknown): Promise<void> {
    try {
      const { chassi, evento, tipoevento } = this.extrairDadosWebhook(payload);

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
      this.logger.error('[Webhook] Erro ao disparar notificação por evento', err?.stack || err);
    }
  }

}
