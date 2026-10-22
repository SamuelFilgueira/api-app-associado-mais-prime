import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ReinspectionBoletoStatus } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { BOLETO_REATIVACAO_RETRY_QUEUE } from 'src/queue/queue.module';
import { TENANT } from 'src/config/tenant.config';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { debugLog } from 'src/shared/debug-log.util';
import { baseTag } from 'src/shared/log.util';
import { formatDateBR, parseDateBR } from 'src/shared/date.util';
import {
  CODIGO_TIPO_BOLETO_REATIVACAO,
  SgaService,
} from 'src/sga/services/sga.service';
import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import {
  erroDaExcecaoSga,
  erroDaRespostaSga,
} from 'src/sga/helpers/sga-instabilidade.helper';
import {
  BoletoReativacaoRetryConfig,
  JOB_ID_PREFIXO_RETRY_BOLETO,
  JOB_RETRY_BOLETO_REATIVACAO,
  excedeuJanelaRetry,
  getBoletoReativacaoRetryConfig,
  intervaloRetryMs,
} from 'src/sga/config/boleto-reativacao-retry.config';

export type BoletoReativacaoOrigem = 'APROVACAO' | 'RETRY' | 'MANUAL';

export interface BoletoReativacaoResultado {
  reinspectionId: number;
  status: ReinspectionBoletoStatus;
  /** PULADO: nada foi feito porque o boleto já estava gerado para esta revistoria. */
  pulado: boolean;
  /** Boleto já existia no SGA (criado à mão) e foi adotado em vez de cadastrado. */
  adotado: boolean;
  nossoNumero: string | null;
  linkBoleto: string | null;
  tentativas: number;
  proximaTentativaEm: Date | null;
  erro: string | null;
  suriEnviada: boolean;
  emailEnviado: boolean;
}

export interface BoletoReativacaoRetryJobData {
  reinspectionId: number;
  debugId?: string;
}

/** Situação 2 = ABERTO na tabela oficial do SGA. */
const SITUACAO_BOLETO_ABERTO = '2';
const ERRO_MAX_CHARS = 500;
const SGA_LISTAR_TIMEOUT_MS = 30_000;

interface BoletoSgaItem {
  nosso_numero?: number | string;
  linha_digitavel?: string;
  link_boleto?: string;
  codigo_situacao_boleto?: number | string;
  codigo_tipo_boleto?: number | string;
  data_vencimento_original?: string;
  data_vencimento?: string;
  veiculos?: Array<{ codigo_veiculo?: number | string }>;
  codigo_veiculo?: number | string;
  [key: string]: unknown;
}

/**
 * Orquestra a criação do boleto de reativação após a aprovação da revistoria.
 *
 * Fluxo de cada tentativa (`processar`):
 * 1. Se a revistoria já tem boleto (`boletoStatus = GERADO`), não faz nada.
 * 2. Procura no SGA um boleto de reativação em aberto para o veículo
 *    (criado à mão por uma operadora enquanto a API estava em retry).
 *    Se achar, adota: grava o pagamento, agenda o poller, manda Suri e e-mail.
 * 3. Senão, cadastra pela API (`SgaService.criarBoletoReativacao`), que já
 *    conclui com poller e Suri; aqui sai o e-mail de aprovação.
 * 4. Instabilidade do SGA → `PENDENTE_RETRY` e job na fila para daqui a
 *    `intervaloMin` minutos, até `maxHoras` da primeira tentativa.
 *    Erro definitivo (ou janela esgotada) → `FALHA` e e-mail avisando a
 *    cobrança que o boleto precisa ser gerado à mão.
 *
 * Nunca lança para o chamador em erro de SGA/rede; só em revistoria inexistente.
 */
@Injectable()
export class BoletoReativacaoService {
  private readonly logger = new Logger(BoletoReativacaoService.name);
  private readonly config: BoletoReativacaoRetryConfig =
    getBoletoReativacaoRetryConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sgaService: SgaService,
    private readonly sgaAuthService: SgaAuthService,
    private readonly mailService: MailService,
    @InjectQueue(BOLETO_REATIVACAO_RETRY_QUEUE as string)
    private readonly retryQueue: Queue,
  ) {}

  async processar(
    reinspectionId: number,
    opcoes: { origem: BoletoReativacaoOrigem; debugId?: string },
  ): Promise<BoletoReativacaoResultado> {
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        status: true,
        codigoVeiculo: true,
        boletoStatus: true,
        boletoTentativas: true,
        boletoNossoNumero: true,
        boletoUltimaTentativaEm: true,
        boletoRetryInicioEm: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: {
          select: {
            id: true,
            chassi: true,
            plate: true,
            user: { select: { cpf: true, baseOrigin: true } },
          },
        },
      },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const base: BaseOrigin =
      reinspection.userVehicle.user?.baseOrigin ?? TENANT.defaultBase;
    const debugId = opcoes.debugId;
    const log = (nivel: 'log' | 'warn' | 'error', msg: string, meta = {}) =>
      this.logger[nivel](
        `${baseTag(base)} ${debugLog(BoletoReativacaoService.name, msg, debugId, { reinspectionId, origem: opcoes.origem, ...meta })}`,
      );

    if (reinspection.boletoStatus === ReinspectionBoletoStatus.GERADO) {
      log('log', 'Boleto já gerado para esta revistoria; nada a fazer');
      return this.resultado(reinspection.id, {
        status: ReinspectionBoletoStatus.GERADO,
        pulado: true,
        nossoNumero: reinspection.boletoNossoNumero,
        tentativas: reinspection.boletoTentativas,
      });
    }

    // Garantia: só a aprovação inicia o processo de boleto. Retry e geração
    // manual atuam apenas em revistorias que já passaram pelo fluxo novo
    // (PENDENTE_RETRY/FALHA). Revistorias aprovadas antes desta versão ficam
    // NAO_GERADO para sempre e nunca têm boleto criado retroativamente.
    if (
      opcoes.origem !== 'APROVACAO' &&
      reinspection.boletoStatus === ReinspectionBoletoStatus.NAO_GERADO
    ) {
      log(
        'warn',
        'Revistoria sem tentativa de boleto registrada (anterior ao fluxo); ignorada',
      );
      return this.resultado(reinspection.id, {
        status: ReinspectionBoletoStatus.NAO_GERADO,
        pulado: true,
        tentativas: reinspection.boletoTentativas,
        erro: 'Revistoria aprovada antes do fluxo automático de boleto; gere manualmente no SGA',
      });
    }

    const tentativa = reinspection.boletoTentativas + 1;
    const agora = new Date();
    const { chassi, plate } = reinspection.userVehicle;

    // Lock otimista: só uma tentativa por vez por revistoria. Duplo clique no
    // painel ou retry da fila coincidindo com "Gerar boleto" leriam o mesmo
    // estado e cadastrariam dois boletos no SGA. Quem perde a corrida sai
    // sem tocar o SGA.
    const lock = await this.prisma.reinspection.updateMany({
      where: {
        id: reinspection.id,
        boletoTentativas: reinspection.boletoTentativas,
        boletoStatus: { not: ReinspectionBoletoStatus.GERADO },
      },
      data: { boletoTentativas: tentativa, boletoUltimaTentativaEm: agora },
    });
    if (lock.count === 0) {
      log('warn', 'Outra tentativa de boleto em andamento; esta foi ignorada', {
        tentativa,
      });
      return this.resultado(reinspection.id, {
        status: reinspection.boletoStatus,
        pulado: true,
        nossoNumero: reinspection.boletoNossoNumero,
        tentativas: reinspection.boletoTentativas,
      });
    }

    try {
      // Validações locais: não mudam com retry.
      if (!plate) {
        throw new BoletoReativacaoDefinitivoError(
          'Placa não cadastrada para o veículo',
          'dados-locais',
        );
      }
      const cpf = reinspection.userVehicle.user?.cpf?.replace(/\D/g, '');
      if (!cpf) {
        throw new BoletoReativacaoDefinitivoError(
          'CPF não encontrado para o veículo',
          'dados-locais',
        );
      }

      // 1) Boleto de reativação já existente no SGA (criado manualmente)?
      const codigoVeiculo =
        reinspection.codigoVeiculo != null
          ? String(reinspection.codigoVeiculo)
          : null;
      const existente = codigoVeiculo
        ? await this.localizarBoletoReativacaoAberto(codigoVeiculo, base)
        : null;

      let nossoNumero: string | null;
      let linkBoleto: string | null;
      let suriEnviada = false;
      let adotado = false;

      if (existente) {
        adotado = true;
        nossoNumero = existente.nossoNumero;
        linkBoleto = existente.linkBoleto;
        log('warn', 'Boleto de reativação já existia no SGA; adotando', {
          nossoNumero,
          tentativa,
        });

        const associado = await this.sgaService.buscarDadosAssociadoParaBoleto(
          cpf,
          base,
        );
        await this.sgaService.registrarPagamentoBoleto({
          userVehicleId: reinspection.userVehicle.id,
          reinspectionId: reinspection.id,
          nossoNumero,
          linhaDigitavel: existente.linhaDigitavel,
          linkBoleto,
          debugId,
        });
        const concluido = await this.sgaService.concluirBoletoReativacao({
          userVehicleId: reinspection.userVehicle.id,
          baseOrigin: base,
          nossoNumero,
          linkBoleto,
          codigoVeiculo,
          associado,
          debugId,
        });
        suriEnviada = concluido.suriEnviada;
      } else {
        const criado = await this.sgaService.criarBoletoReativacao(
          reinspection.userVehicle.id,
          plate,
          debugId,
          { reinspectionId: reinspection.id },
        );
        nossoNumero = criado.nossoNumero;
        linkBoleto = criado.linkBoleto;
        suriEnviada = criado.suriEnviada;
      }

      await this.prisma.reinspection.update({
        where: { id: reinspection.id },
        data: {
          boletoStatus: ReinspectionBoletoStatus.GERADO,
          boletoTentativas: tentativa,
          boletoUltimaTentativaEm: agora,
          boletoProximaTentativaEm: null,
          boletoRetryInicioEm: null,
          boletoUltimoErro: null,
          boletoNossoNumero: nossoNumero,
          boletoOrigem: adotado ? 'ADOTADO_SGA' : 'CRIADO_APP',
        },
      });

      const emailEnviado = await this.enviarEmailAprovada(
        chassi,
        plate,
        debugId,
      );

      log('log', 'Boleto de reativação concluído', {
        nossoNumero,
        adotado,
        tentativa,
        suriEnviada,
        emailEnviado,
      });

      return this.resultado(reinspection.id, {
        status: ReinspectionBoletoStatus.GERADO,
        adotado,
        nossoNumero,
        linkBoleto,
        tentativas: tentativa,
        suriEnviada,
        emailEnviado,
      });
    } catch (error) {
      const erroTipado =
        error instanceof BoletoReativacaoDefinitivoError ||
        error instanceof BoletoReativacaoInstabilidadeError
          ? error
          : erroDaExcecaoSga('desconhecido', error);
      const mensagem = this.truncar(erroTipado.message);

      // Janela de retry: começa na primeira falha por instabilidade e zera
      // quando a tentativa é manual (operador pediu de novo) ou quando a
      // revistoria não estava em PENDENTE_RETRY.
      const continuaJanela =
        opcoes.origem !== 'MANUAL' &&
        reinspection.boletoStatus === ReinspectionBoletoStatus.PENDENTE_RETRY &&
        reinspection.boletoRetryInicioEm != null;
      const inicioJanela = continuaJanela
        ? reinspection.boletoRetryInicioEm!
        : agora;
      const esgotou = excedeuJanelaRetry(
        this.config,
        inicioJanela.getTime(),
        agora.getTime(),
      );
      const deveRetentar =
        erroTipado instanceof BoletoReativacaoInstabilidadeError && !esgotou;

      if (deveRetentar) {
        const proxima = new Date(
          agora.getTime() + intervaloRetryMs(this.config),
        );
        await this.prisma.reinspection.update({
          where: { id: reinspection.id },
          data: {
            boletoStatus: ReinspectionBoletoStatus.PENDENTE_RETRY,
            boletoTentativas: tentativa,
            boletoUltimaTentativaEm: agora,
            boletoProximaTentativaEm: proxima,
            boletoUltimoErro: mensagem,
            boletoRetryInicioEm: inicioJanela,
          },
        });
        await this.agendarRetry(
          reinspection.id,
          tentativa + 1,
          proxima,
          debugId,
        );
        log('warn', 'Boleto de reativação adiado por instabilidade do SGA', {
          tentativa,
          proximaTentativaEm: proxima.toISOString(),
          erro: mensagem,
        });
        return this.resultado(reinspection.id, {
          status: ReinspectionBoletoStatus.PENDENTE_RETRY,
          tentativas: tentativa,
          proximaTentativaEm: proxima,
          erro: mensagem,
        });
      }

      const motivo = esgotou
        ? `Janela de retry esgotada (${this.config.maxHoras}h). Último erro: ${mensagem}`
        : mensagem;
      await this.prisma.reinspection.update({
        where: { id: reinspection.id },
        data: {
          boletoStatus: ReinspectionBoletoStatus.FALHA,
          boletoTentativas: tentativa,
          boletoUltimaTentativaEm: agora,
          boletoProximaTentativaEm: null,
          boletoRetryInicioEm: null,
          boletoUltimoErro: this.truncar(motivo),
        },
      });
      const emailEnviado = await this.enviarEmailSemBoleto(
        chassi,
        plate,
        motivo,
        debugId,
      );
      log('error', 'Boleto de reativação não gerado', {
        tentativa,
        definitivo: !esgotou,
        erro: motivo,
        emailEnviado,
      });
      return this.resultado(reinspection.id, {
        status: ReinspectionBoletoStatus.FALHA,
        tentativas: tentativa,
        erro: this.truncar(motivo),
        emailEnviado,
      });
    }
  }

  /**
   * Garante job de retry para toda revistoria `PENDENTE_RETRY` (reinício do
   * processo entre a falha e o reagendamento, ou Redis limpo). `jobId`
   * determinístico evita duplicar um job que já esteja na fila.
   */
  async reconciliarPendentes(): Promise<{
    pendentes: number;
    agendados: number;
  }> {
    const pendentes = await this.prisma.reinspection.findMany({
      where: { boletoStatus: ReinspectionBoletoStatus.PENDENTE_RETRY },
      select: {
        id: true,
        boletoTentativas: true,
        boletoProximaTentativaEm: true,
      },
    });

    let agendados = 0;
    for (const r of pendentes) {
      const quando =
        r.boletoProximaTentativaEm ??
        new Date(Date.now() + intervaloRetryMs(this.config));
      await this.agendarRetry(r.id, r.boletoTentativas + 1, quando);
      agendados++;
    }
    return { pendentes: pendentes.length, agendados };
  }

  /** Revistorias aguardando retry ou com falha definitiva (visão do painel). */
  async listarPendentes() {
    const itens = await this.prisma.reinspection.findMany({
      where: {
        boletoStatus: {
          in: [
            ReinspectionBoletoStatus.PENDENTE_RETRY,
            ReinspectionBoletoStatus.FALHA,
          ],
        },
      },
      orderBy: { boletoUltimaTentativaEm: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        vehicleType: true,
        status: true,
        boletoStatus: true,
        boletoTentativas: true,
        boletoUltimaTentativaEm: true,
        boletoProximaTentativaEm: true,
        boletoUltimoErro: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: { select: { chassi: true, plate: true } },
      },
    });
    return itens.map(({ userVehicle, ...r }) => ({
      ...r,
      chassi: userVehicle.chassi,
      plate: userVehicle.plate,
    }));
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * Procura em `listar/boleto-associado-veiculo` um boleto do veículo que
   * seja de reativação (`codigo_tipo_boleto = 2`), em ABERTO e com vencimento
   * original de hoje até hoje + janela. O SGA não devolve data de criação,
   * então o critério "criado hoje" é aproximado por tipo + situação +
   * vencimento futuro. Boleto de mensalidade (outro tipo) nunca é adotado.
   * Erro do SGA aqui é instabilidade (vale retry).
   */
  private async localizarBoletoReativacaoAberto(
    codigoVeiculo: string,
    baseOrigin: BaseOrigin,
  ): Promise<{
    nossoNumero: string;
    linhaDigitavel: string | null;
    linkBoleto: string | null;
  } | null> {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const fim = new Date(hoje);
    fim.setDate(fim.getDate() + this.config.janelaVencimentoDias);

    let response: { status: number; data: unknown };
    try {
      response = await this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
        method: 'POST',
        url: `${SGA_BASE_URL}/listar/boleto-associado-veiculo`,
        data: {
          codigo_veiculo: Number(codigoVeiculo),
          data_vencimento_original_inicial: formatDateBR(hoje),
          data_vencimento_original_final: formatDateBR(fim),
        },
        headers: { 'Content-Type': 'application/json' },
        timeout: SGA_LISTAR_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      throw erroDaExcecaoSga('listar/boleto-associado-veiculo', error);
    }

    // 404/sem boletos é resposta normal ("nenhum boleto"), não erro.
    if (response.status === 404 || response.status === 406) {
      return null;
    }
    if (response.status >= 400) {
      throw erroDaRespostaSga(
        'listar/boleto-associado-veiculo',
        response.status,
        response.data,
      );
    }
    if (!Array.isArray(response.data)) {
      return null;
    }

    const candidatos = (response.data as BoletoSgaItem[]).filter((item) => {
      if (!item || typeof item !== 'object' || item.nosso_numero == null) {
        return false;
      }
      if (!this.pertenceAoVeiculo(item, codigoVeiculo)) return false;
      if (
        String(item.codigo_situacao_boleto ?? '') !== SITUACAO_BOLETO_ABERTO
      ) {
        return false;
      }
      if (
        item.codigo_tipo_boleto == null ||
        Number(item.codigo_tipo_boleto) !== CODIGO_TIPO_BOLETO_REATIVACAO
      ) {
        return false;
      }
      const vencimento = parseDateBR(
        item.data_vencimento_original ?? item.data_vencimento,
      );
      return vencimento != null && vencimento.getTime() >= hoje.getTime();
    });

    if (candidatos.length === 0) return null;

    // Mais de um candidato: usa o de vencimento mais próximo (o mais recente
    // que uma operadora teria criado hoje).
    candidatos.sort((a, b) => {
      const va = parseDateBR(a.data_vencimento_original ?? a.data_vencimento);
      const vb = parseDateBR(b.data_vencimento_original ?? b.data_vencimento);
      return (va?.getTime() ?? 0) - (vb?.getTime() ?? 0);
    });
    const escolhido = candidatos[0];

    return {
      nossoNumero: String(escolhido.nosso_numero),
      linhaDigitavel:
        typeof escolhido.linha_digitavel === 'string'
          ? escolhido.linha_digitavel
          : null,
      linkBoleto:
        typeof escolhido.link_boleto === 'string'
          ? escolhido.link_boleto
          : null,
    };
  }

  private pertenceAoVeiculo(
    item: BoletoSgaItem,
    codigoVeiculo: string,
  ): boolean {
    if (item.codigo_veiculo != null) {
      return String(item.codigo_veiculo) === codigoVeiculo;
    }
    if (Array.isArray(item.veiculos) && item.veiculos.length > 0) {
      return item.veiculos.some(
        (v) =>
          v?.codigo_veiculo != null &&
          String(v.codigo_veiculo) === codigoVeiculo,
      );
    }
    // Sem identificador de veículo na resposta: a consulta já foi por
    // codigo_veiculo, então aceita.
    return true;
  }

  private async agendarRetry(
    reinspectionId: number,
    tentativa: number,
    quando: Date,
    debugId?: string,
  ): Promise<void> {
    const delay = Math.max(0, quando.getTime() - Date.now());
    const data: BoletoReativacaoRetryJobData = { reinspectionId, debugId };
    await this.retryQueue.add(JOB_RETRY_BOLETO_REATIVACAO, data, {
      delay,
      jobId: `${JOB_ID_PREFIXO_RETRY_BOLETO}${reinspectionId}-${tentativa}`,
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    });
  }

  private async enviarEmailAprovada(
    chassi: string,
    plate: string | null,
    debugId?: string,
  ): Promise<boolean> {
    try {
      await this.mailService.sendRevistoriaAprovadaEmail(
        chassi,
        plate,
        debugId,
      );
      return true;
    } catch {
      // MailService já loga o erro com contexto.
      return false;
    }
  }

  private async enviarEmailSemBoleto(
    chassi: string,
    plate: string | null,
    motivo: string,
    debugId?: string,
  ): Promise<boolean> {
    try {
      await this.mailService.sendRevistoriaAprovadaSemBoletoEmail(
        chassi,
        plate,
        motivo,
        debugId,
      );
      return true;
    } catch {
      return false;
    }
  }

  private resultado(
    reinspectionId: number,
    parcial: Partial<BoletoReativacaoResultado> & {
      status: ReinspectionBoletoStatus;
    },
  ): BoletoReativacaoResultado {
    return {
      reinspectionId,
      pulado: false,
      adotado: false,
      nossoNumero: null,
      linkBoleto: null,
      tentativas: 0,
      proximaTentativaEm: null,
      erro: null,
      suriEnviada: false,
      emailEnviado: false,
      ...parcial,
    };
  }

  private truncar(valor: string): string {
    return valor.length > ERRO_MAX_CHARS
      ? valor.slice(0, ERRO_MAX_CHARS)
      : valor;
  }
}
