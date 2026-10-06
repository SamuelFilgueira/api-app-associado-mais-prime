import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { debugLog } from 'src/shared/debug-log.util';
import { janelaVencimentoBoleto } from 'src/sga/helpers/janela-boleto.helper';
import {
  BoletoVerificacaoConfig,
  JOB_ID_PREFIXO_VERIFICACAO,
  JOB_VERIFICAR_BOLETO,
  deveConsultarSga,
  excedeuIdadeMaxima,
  getBoletoVerificacaoConfig,
} from 'src/sga/config/boleto-verificacao.config';

interface BoletoVerificacaoJobData {
  userVehicleId: number;
  nosso_numero: number;
  codigo_veiculo: string;
  codigo_associado?: number;
  baseOrigin: BaseOrigin;
  nome?: string;
  telefone_celular?: string;
  debugId?: string;
}

/** Situações do boleto no SGA (tabela oficial): 1 BAIXADO, 4 BAIXADO C/ PENDÊNCIA. */
const SITUACOES_PAGO = new Set(['1', '4']);
/** 3 CANCELADO, 999 EXCLUÍDO — o boleto nunca mais será pago; a verificação encerra. */
const SITUACOES_ENCERRADO = new Set(['3', '999']);

@Processor(BOLETO_VERIFICACAO_QUEUE as string)
export class BoletoVerificacaoProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(BoletoVerificacaoProcessor.name);
  private readonly config: BoletoVerificacaoConfig =
    getBoletoVerificacaoConfig();
  /** Instante da última sondagem ao SGA feita por este worker (espaçamento). */
  private ultimaChamadaSgaEm = 0;

  constructor(
    private readonly sgaAuthService: SgaAuthService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly suriNotificacaoService: SuriNotificacaoService,
    @InjectQueue(BOLETO_VERIFICACAO_QUEUE as string)
    private readonly queue: Queue,
  ) {
    super();
  }

  /**
   * No boot, encerra pollers de boletos já além da idade máxima: repeatables
   * antigos foram criados sem `endDate` e ficariam ativos para sempre.
   * Nunca derruba o boot.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { ativos, removidos } = await this.limparPollersExpirados();
      this.logger.log(
        `Pollers de boleto de reativação ativos: ${ativos}; encerrados por idade (> ${this.config.maxDias} dias): ${removidos}`,
      );
    } catch (error) {
      this.logger.error(
        `Falha ao limpar pollers de boleto expirados: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async limparPollersExpirados(): Promise<{
    ativos: number;
    removidos: number;
  }> {
    const repeatables = await this.queue.getRepeatableJobs();
    const pollers = repeatables.filter((r) => r.name === JOB_VERIFICAR_BOLETO);
    const agora = Date.now();
    let removidos = 0;

    for (const poller of pollers) {
      const nossoNumero = poller.id?.startsWith(JOB_ID_PREFIXO_VERIFICACAO)
        ? poller.id.slice(JOB_ID_PREFIXO_VERIFICACAO.length)
        : null;
      if (!nossoNumero) continue;

      const pagamento = await this.prisma.reinspectionPayment.findUnique({
        where: { nossoNumero },
        select: { boletoCriadoEm: true },
      });
      if (
        !pagamento ||
        !excedeuIdadeMaxima(
          this.config,
          pagamento.boletoCriadoEm.getTime(),
          agora,
        )
      ) {
        continue;
      }

      await this.queue.removeRepeatableByKey(poller.key);
      removidos++;
      this.logger.warn(
        `Poller do boleto nosso_numero=${nossoNumero} encerrado no boot: criado em ${pagamento.boletoCriadoEm.toISOString()}, além da idade máxima.`,
      );
    }

    return { ativos: pollers.length - removidos, removidos };
  }

  async process(job: Job<BoletoVerificacaoJobData>): Promise<void> {
    const {
      userVehicleId,
      nosso_numero,
      codigo_veiculo,
      codigo_associado,
      baseOrigin,
      nome,
      telefone_celular,
      debugId,
    } = job.data;

    // Idade máxima e cadência por idade: decididas pelo banco, sem tocar o SGA.
    const agora = Date.now();
    const pagamento = await this.buscarPagamento(nosso_numero);
    if (pagamento) {
      const criadoEm = pagamento.boletoCriadoEm.getTime();

      if (excedeuIdadeMaxima(this.config, criadoEm, agora)) {
        this.logger.warn(
          debugLog(
            BoletoVerificacaoProcessor.name,
            'Verificação encerrada: boleto além da idade máxima',
            debugId,
            {
              nossoNumero: nosso_numero,
              boletoCriadoEm: pagamento.boletoCriadoEm.toISOString(),
              maxDias: this.config.maxDias,
            },
          ),
        );
        await this.encerrarPoller(job);
        return;
      }

      // Pago no banco com o poller ainda ativo (ex.: reinício entre a gravação
      // e a reativação): vai direto ao SGA para concluir a reativação.
      if (
        !pagamento.pago &&
        !deveConsultarSga(this.config, {
          criadoEm,
          ultimaConsultaEm: pagamento.updatedAt.getTime(),
          agora,
        })
      ) {
        return;
      }
    }

    const url = `${SGA_BASE_URL}/processa-pdf/boleto`;

    await this.espacarChamadaSga();
    const response = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      {
        method: 'POST',
        url,
        data: { nosso_numero },
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      },
    );

    if (response.status >= 400) {
      this.logger.warn(
        debugLog(
          BoletoVerificacaoProcessor.name,
          'Erro ao verificar boleto',
          debugId,
          {
            nossoNumero: nosso_numero,
            status: response.status,
            body: response.data,
          },
        ),
      );
      return;
    }

    type BoletoInfo = {
      nosso_numero?: number | string;
      codigo_situacao_boleto?: number | string;
      linha_digitavel?: string;
      link_boleto?: string;
      [key: string]: unknown;
    };

    const normalizeArray = (input: unknown): BoletoInfo[] => {
      if (!input) return [];

      if (Array.isArray(input)) {
        return input.filter(
          (item): item is BoletoInfo => !!item && typeof item === 'object',
        );
      }

      if (typeof input === 'object') {
        const record = input as Record<string, unknown>;

        if (Array.isArray(record.dados_boleto_inserido)) {
          return record.dados_boleto_inserido.filter(
            (item): item is BoletoInfo => !!item && typeof item === 'object',
          );
        }

        const numericKeyItems = Object.entries(record)
          .filter(
            ([key, value]) =>
              /^\d+$/.test(key) && !!value && typeof value === 'object',
          )
          .map(([, value]) => value as BoletoInfo);

        if (numericKeyItems.length > 0) {
          return numericKeyItems;
        }

        return [record as BoletoInfo];
      }

      if (typeof input === 'string') {
        try {
          const parsed = JSON.parse(input);
          return normalizeArray(parsed);
        } catch {
          return [];
        }
      }

      return [];
    };

    const boletos = normalizeArray(response.data);
    let boletoInfo =
      boletos.find(
        (item) => String(item?.nosso_numero) === String(nosso_numero),
      ) ?? boletos[0];

    const codigoSituacaoRaw = boletoInfo?.codigo_situacao_boleto;
    let codigoSituacao =
      codigoSituacaoRaw !== undefined && codigoSituacaoRaw !== null
        ? String(codigoSituacaoRaw)
        : undefined;

    // Fallback: quando processa-pdf retorna vazio/N/A, consultar boletos por veículo
    if (!codigoSituacao) {
      const { dataInicialStr, dataFinalStr } = janelaVencimentoBoleto();

      const fallbackBody = {
        codigo_veiculo: Number(codigo_veiculo),
        data_vencimento_original_inicial: dataInicialStr,
        data_vencimento_original_final: dataFinalStr,
      };

      await this.espacarChamadaSga();
      const fallbackResponse = await this.sgaAuthService.executeRequestWithAuth(
        baseOrigin,
        {
          method: 'POST',
          url: `${SGA_BASE_URL}/listar/boleto-associado-veiculo`,
          data: fallbackBody,
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true,
        },
      );

      if (
        fallbackResponse.status < 400 &&
        Array.isArray(fallbackResponse.data)
      ) {
        const boletoFallback = fallbackResponse.data.find(
          (item: { nosso_numero?: number | string }) =>
            String(item?.nosso_numero) === String(nosso_numero),
        );

        if (boletoFallback?.codigo_situacao_boleto !== undefined) {
          codigoSituacao = String(boletoFallback.codigo_situacao_boleto);
          boletoInfo = boletoFallback as BoletoInfo;
        } else {
          this.logger.warn(
            debugLog(
              BoletoVerificacaoProcessor.name,
              'Fallback sem status para nosso_numero informado',
              debugId,
              {
                nossoNumero: nosso_numero,
                encontrados: fallbackResponse.data.length,
              },
            ),
          );
        }
      } else {
        this.logger.warn(
          debugLog(
            BoletoVerificacaoProcessor.name,
            'Fallback retornou erro',
            debugId,
            {
              nossoNumero: nosso_numero,
              status: fallbackResponse.status,
            },
          ),
        );
      }
    }

    const pago =
      codigoSituacao !== undefined && SITUACOES_PAGO.has(codigoSituacao);

    // Persistir/atualizar status do pagamento em toda consulta ao SGA
    // (o `updatedAt` desta linha é a "última consulta" usada pela cadência).
    try {
      await this.prisma.reinspectionPayment.upsert({
        where: { nossoNumero: String(nosso_numero) },
        update: {
          //linhaDigitavel: boletoInfo?.linha_digitavel ?? null,
          //linkBoleto: boletoInfo?.link_boleto ?? null,
          situacaoBoleto: codigoSituacao ?? 'PENDENTE',
          pago,
          pagoEm: pago ? new Date() : null,
        },
        create: {
          userVehicleId,
          nossoNumero: String(nosso_numero),
          linhaDigitavel: boletoInfo?.linha_digitavel ?? null,
          linkBoleto: boletoInfo?.link_boleto ?? null,
          situacaoBoleto: codigoSituacao ?? 'PENDENTE',
          boletoCriadoEm: new Date(),
          pago,
          pagoEm: pago ? new Date() : null,
        },
      });
    } catch (persistError) {
      this.logger.error(
        debugLog(
          BoletoVerificacaoProcessor.name,
          'Falha ao persistir pagamento de revistoria (job)',
          debugId,
          {
            userVehicleId,
            nossoNumero: nosso_numero,
            error:
              persistError instanceof Error
                ? persistError.message
                : String(persistError),
          },
        ),
      );
    }

    // Boleto cancelado/excluído no SGA: nunca mais será pago — encerra o poller
    if (
      codigoSituacao !== undefined &&
      SITUACOES_ENCERRADO.has(codigoSituacao)
    ) {
      this.logger.log(
        debugLog(
          BoletoVerificacaoProcessor.name,
          'Verificação encerrada: boleto cancelado/excluído no SGA',
          debugId,
          { nossoNumero: nosso_numero, situacao: codigoSituacao },
        ),
      );
      await this.encerrarPoller(job);
      return;
    }

    if (!pago) {
      return;
    }

    // Boleto pago/liquidado — reativar veículo (situação 1)
    this.logger.log(
      debugLog(
        BoletoVerificacaoProcessor.name,
        'Boleto pago! Reativando veículo',
        debugId,
        {
          nossoNumero: nosso_numero,
          codigoVeiculo: codigo_veiculo,
        },
      ),
    );

    // Enviar e-mail de boleto pago para a equipe
    try {
      const vehicleData = await this.prisma.userVehicle.findUnique({
        where: { id: userVehicleId },
        select: { chassi: true, plate: true },
      });

      await this.mailService.sendBoletoRevistoriaPago(
        vehicleData?.chassi ?? 'N/A',
        vehicleData?.plate ?? null,
        debugId,
      );
    } catch (mailError) {
      this.logger.error(
        debugLog(
          BoletoVerificacaoProcessor.name,
          'Falha ao enviar e-mail de boleto pago',
          debugId,
          {
            userVehicleId,
            nossoNumero: nosso_numero,
            error:
              mailError instanceof Error
                ? mailError.message
                : String(mailError),
          },
        ),
      );
    }

    const alterarUrl = `${SGA_BASE_URL}/veiculo/alterar-situacao-para/1/${codigo_veiculo}`;

    const alterarResponse = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      { method: 'GET', url: alterarUrl, validateStatus: () => true },
    );

    this.logger.log(
      debugLog(
        BoletoVerificacaoProcessor.name,
        'Veículo reativado (situação 1)',
        debugId,
        {
          codigoVeiculo: codigo_veiculo,
          status: alterarResponse.status,
        },
      ),
    );

    // Após confirmação de pagamento, reativar associado (situação 1)
    if (codigo_associado) {
      const alterarAssociadoUrl = `${SGA_BASE_URL}/associado/alterar-situacao-para/1/${codigo_associado}`;

      const alterarAssociadoResponse =
        await this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
          method: 'GET',
          url: alterarAssociadoUrl,
          validateStatus: () => true,
        });

      if (alterarAssociadoResponse.status >= 400) {
        this.logger.warn(
          debugLog(
            BoletoVerificacaoProcessor.name,
            'Falha ao reativar associado (situação 1)',
            debugId,
            {
              codigoAssociado: codigo_associado,
              status: alterarAssociadoResponse.status,
              body: alterarAssociadoResponse.data,
            },
          ),
        );
      }
    } else {
      this.logger.warn(
        debugLog(
          BoletoVerificacaoProcessor.name,
          'codigo_associado ausente no job; reativação de associado não executada',
          debugId,
          {
            nossoNumero: nosso_numero,
            userVehicleId,
          },
        ),
      );
    }

    // Remover o job recorrente
    await this.encerrarPoller(job);

    // Notificar usuário via Suri que o boleto foi pago
    if (nome && telefone_celular) {
      try {
        await this.suriNotificacaoService.enviarTemplate({
          nome,
          telefoneCelular: telefone_celular,
          templateId: process.env.suri_template_id_boleto_pago,
        });
      } catch (suriError) {
        this.logger.error(
          debugLog(
            BoletoVerificacaoProcessor.name,
            'Falha ao enviar notificação Suri (boleto pago)',
            debugId,
            {
              nossoNumero: nosso_numero,
              error:
                suriError instanceof Error
                  ? suriError.message
                  : String(suriError),
            },
          ),
        );
      }
    } else {
      this.logger.warn(
        debugLog(
          BoletoVerificacaoProcessor.name,
          'Notificação Suri (boleto pago) não enviada — nome ou telefone ausente',
          debugId,
          {
            nossoNumero: nosso_numero,
            temNome: !!nome,
            temTelefone: !!telefone_celular,
          },
        ),
      );
    }
  }

  /**
   * Linha do pagamento usada para cadência/idade. Falha de leitura não
   * interrompe o job: sem a linha, o fluxo segue como sempre (consulta o SGA).
   */
  private async buscarPagamento(nossoNumero: number) {
    try {
      return await this.prisma.reinspectionPayment.findUnique({
        where: { nossoNumero: String(nossoNumero) },
        select: { pago: true, boletoCriadoEm: true, updatedAt: true },
      });
    } catch (error) {
      this.logger.warn(
        `Falha ao ler pagamento nosso_numero=${nossoNumero} antes da verificação: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Remove o repeatable deste boleto (encerra o poller). */
  private async encerrarPoller(job: Job<BoletoVerificacaoJobData>) {
    if (job.repeatJobKey) {
      await this.queue.removeRepeatableByKey(job.repeatJobKey);
    }
  }

  /**
   * Garante um espaçamento mínimo entre sondagens consecutivas ao SGA. O
   * BullMQ alinha todos os repeatables `every` ao relógio, então os pollers
   * disparam juntos; sem isto as chamadas saem em rajada.
   */
  private async espacarChamadaSga(): Promise<void> {
    const espera =
      this.ultimaChamadaSgaEm + this.config.espacamentoMs - Date.now();
    if (espera > 0) {
      await new Promise((resolve) => setTimeout(resolve, espera));
    }
    this.ultimaChamadaSgaEm = Date.now();
  }
}
