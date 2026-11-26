import {
  Injectable,
  Logger,
  UnprocessableEntityException,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DadosDoResumo } from 'src/analytics/domain/agregados-diarios';
import {
  MENSAGEM_DE_PERIODO_INVALIDO,
  excedeTamanhoMaximo,
  filtrarPelasAllowlists,
  montarResumoSanitizado,
  normalizarIdDoUsuario,
  validarPeriodo,
} from 'src/analytics/domain/resumo-recebido';
import { CreateAnalyticsSummaryDto } from 'src/analytics/dto/create-analytics-summary.dto';
import { scanForProhibitedKeys } from 'src/analytics/utils/prohibited-key-scanner.util';
import { hmacSha256, sha256 } from 'src/analytics/utils/analytics-hash.util';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { ANALYTICS_QUEUE } from 'src/queue/queue.module';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';
import {
  sanitizeDeviceInfo,
  sanitizeJourney,
} from 'src/analytics/utils/analytics-journey.util';

const RATE_LIMIT_IP_WINDOW_SEC = 60;
const RATE_LIMIT_IP_MAX = 10;
const RATE_LIMIT_INSTALL_WINDOW_SEC = 3600;
const RATE_LIMIT_INSTALL_MAX = 20;

/** Nome do job de ingestão na `ANALYTICS_QUEUE`. */
export const JOB_PROCESSAR_RESUMO = 'process-summary';

function isTruthyEnv(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Entrada dos summaries do app (`POST /analytics/summaries`): confere as
 * barreiras, sanitiza e enfileira. Quem aplica nos agregados é o worker
 * (`AnalyticsAplicarResumoService`); os dashboards ficam em
 * `AnalyticsDashboardService`.
 *
 * Barreiras, nesta ordem: tamanho (64 KB) → rate limit por IP → chaves
 * proibidas → schema → período → rate limit por instalação → allowlists.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly produtor: ProdutorDeFilas,
    private readonly limitador: LimitadorService,
  ) {}

  async ingest(
    rawBody: unknown,
    clientIp: string,
    rateLimitEnabled: boolean,
    jwtUserId?: unknown,
  ): Promise<{ message: string }> {
    // 1. Verificar tamanho do payload
    let payloadStr: string | undefined;
    try {
      payloadStr = JSON.stringify(rawBody);
    } catch {
      throw new UnprocessableEntityException('Payload inválido');
    }

    // JSON.stringify(undefined) retorna undefined (não lança exceção).
    if (typeof payloadStr !== 'string') {
      throw new UnprocessableEntityException('Payload inválido');
    }

    if (excedeTamanhoMaximo(payloadStr)) {
      throw new UnprocessableEntityException(
        'Payload excede o tamanho máximo permitido',
      );
    }

    // 2. Rate limit por IP (proteção de infraestrutura)
    if (rateLimitEnabled) {
      await this.checkIpRateLimit(clientIp);
    }

    // 3. Varrer chaves proibidas no objeto bruto
    const prohibited = scanForProhibitedKeys(rawBody);
    if (prohibited.length > 0) {
      throw new UnprocessableEntityException(
        'Payload contém propriedades não permitidas',
      );
    }

    // 4. Validar schema via class-validator (retorna 422, não 400)
    const dto = plainToInstance(CreateAnalyticsSummaryDto, rawBody, {
      enableImplicitConversion: false,
      excludeExtraneousValues: false,
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    if (errors.length > 0) {
      throw new UnprocessableEntityException('Payload com schema inválido');
    }

    // 5. Validar regras de negócio de datas
    const periodStart = new Date(dto.period_start);
    const periodEnd = new Date(dto.period_end);
    const periodoInvalido = validarPeriodo(periodStart, periodEnd);
    if (periodoInvalido) {
      throw new UnprocessableEntityException(
        MENSAGEM_DE_PERIODO_INVALIDO[periodoInvalido],
      );
    }

    // 6. Gerar hashes server-side (nunca persistir UUIDs brutos)
    const analyticsSecret = process.env.ANALYTICS_SECRET!;
    const installHash = hmacSha256(
      dto.session.anonymous_install_id,
      analyticsSecret,
    );
    const sessionHash = hmacSha256(dto.session.session_id, analyticsSecret);

    // 7. Rate limit por install_hash (após validação do body)
    if (rateLimitEnabled) {
      await this.checkInstallRateLimit(installHash);
    }

    // 8. Sanitizar e filtrar pela allowlist
    const aceitos = filtrarPelasAllowlists(dto);

    // 8b. Jornada (opcional). Só entra quando ANALYTICS_JOURNEY_ENABLED=true;
    // com a flag desligada os blocos `device`/`journey` são ignorados por
    // completo (não são persistidos nem contam como descarte).
    const journeyEnabled = isTruthyEnv(process.env.ANALYTICS_JOURNEY_ENABLED);
    const device = journeyEnabled ? sanitizeDeviceInfo(dto.device) : null;
    const journey = journeyEnabled
      ? sanitizeJourney(dto.journey, periodStart, periodEnd)
      : { accepted: [], discarded: 0 };

    // 9. Gerar payloadHash do payload sanitizado (para idempotência)
    const sanitizedPayload = montarResumoSanitizado({
      periodStart: dto.period_start,
      periodEnd: dto.period_end,
      platform: dto.app.platform,
      version: dto.app.version,
      runtimeVersion: dto.app.runtime_version,
      installHash,
      sessionHash,
      aceitos,
    });
    const payloadHash = sha256(JSON.stringify(sanitizedPayload));

    // Capturar userId apenas quando flag de ambiente controlado estiver ativa
    const linkUserEnabled = isTruthyEnv(
      process.env.ANALYTICS_LINK_USER_ENABLED,
    );
    const analyticsUserId = linkUserEnabled
      ? normalizarIdDoUsuario(jwtUserId)
      : null;

    const dados: DadosDoResumo = {
      sanitizedPayload,
      installHash,
      sessionHash,
      payloadHash,
      discardedItemsCount: aceitos.descartados + journey.discarded,
      acceptedScreensCount: aceitos.screens.length,
      acceptedActionsCount: aceitos.actions.length,
      acceptedFormsCount: aceitos.forms.length,
      analyticsUserId,
      // Jornada: só presente quando a flag está ligada. clientIp é gravado
      // no aparelho para cruzar com logs do nginx (precisa de X-Forwarded-For).
      journey: journeyEnabled
        ? {
            device,
            events: journey.accepted,
            clientIp: clientIp === 'unknown' ? null : clientIp,
          }
        : undefined,
    };

    // 10. Enfileirar para processamento assíncrono
    try {
      // Sem base: o summary é anônimo e a ingestão não usa credencial de
      // vendor. `jobId` = `payloadHash`: o reenvio do mesmo summary (retry de
      // rede do app) não cria um segundo job enquanto o primeiro existir no
      // Redis; depois disso, quem barra é o recibo, na transação do worker.
      // Retry e retenção são os da fila (`OPCOES_POR_FILA`).
      await this.produtor.enfileirar(
        ANALYTICS_QUEUE,
        JOB_PROCESSAR_RESUMO,
        dados,
        { jobId: payloadHash },
      );
    } catch {
      this.logger.error('Falha ao enfileirar analytics summary');
      throw new InternalServerErrorException('Erro interno');
    }

    return { message: 'accepted' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RATE LIMIT
  // ─────────────────────────────────────────────────────────────────────────

  private async checkIpRateLimit(ip: string): Promise<void> {
    await this.aplicarLimite(
      `analytics:rl:ip:${ip}`,
      RATE_LIMIT_IP_WINDOW_SEC,
      RATE_LIMIT_IP_MAX,
    );
  }

  private async checkInstallRateLimit(installHash: string): Promise<void> {
    await this.aplicarLimite(
      `analytics:rl:install:${installHash}`,
      RATE_LIMIT_INSTALL_WINDOW_SEC,
      RATE_LIMIT_INSTALL_MAX,
    );
  }

  /**
   * Janela fixa atômica (`LimitadorService`). Antes eram `INCR` e `EXPIRE`
   * separados: uma queda entre os dois deixava a chave sem expiração e o
   * aparelho em 429 para sempre. Com o Redis fora, a telemetria passa sem
   * limite — antes a ingestão inteira respondia 500.
   */
  private async aplicarLimite(
    chave: string,
    janelaSeg: number,
    maximo: number,
  ): Promise<void> {
    let total: number;
    try {
      ({ total } = await this.limitador.consumir(chave, janelaSeg));
    } catch (erro) {
      this.limitador.avisarRedisFora(erro);
      return;
    }

    if (total > maximo) {
      throw new HttpException(
        'Rate limit excedido',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
