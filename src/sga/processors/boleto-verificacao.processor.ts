import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { debugLog } from 'src/shared/debug-log.util';
import { janelaVencimentoBoleto } from 'src/sga/helpers/janela-boleto.helper';

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

@Processor(BOLETO_VERIFICACAO_QUEUE as string)
export class BoletoVerificacaoProcessor extends WorkerHost {
  private readonly logger = new Logger(BoletoVerificacaoProcessor.name);

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

    const url = `${SGA_BASE_URL}/processa-pdf/boleto`;

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

    // Persistir/atualizar status do pagamento em toda execução do job
    try {
      const pago = codigoSituacao === '1' || codigoSituacao === '4';

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

      // this.logger.log(
      //   debugLog(BoletoVerificacaoProcessor.name, 'Pagamento de revistoria persistido (job)', debugId, {
      //     userVehicleId,
      //     nossoNumero: nosso_numero,
      //     situacao: codigoSituacao ?? 'PENDENTE',
      //     pago,
      //   }),
      // );
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

    if (codigoSituacao !== '1' && codigoSituacao !== '4') {
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
    if (job.repeatJobKey) {
      await this.queue.removeRepeatableByKey(job.repeatJobKey);
    }

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
}
