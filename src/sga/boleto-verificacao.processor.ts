import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import axios from 'axios';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';
import { SgaAuthService } from 'src/shared/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { PrismaService } from 'src/prisma.service';
import { MailService } from 'src/common/services/mail.service';

function formatDateBR(date: Date) {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const ano = date.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

interface BoletoVerificacaoJobData {
  userVehicleId: number;
  nosso_numero: number;
  codigo_veiculo: string;
  baseOrigin: BaseOrigin;
  nome?: string;
  telefone_celular?: string;
}

@Processor(BOLETO_VERIFICACAO_QUEUE as string)
export class BoletoVerificacaoProcessor extends WorkerHost {
  private readonly logger = new Logger(BoletoVerificacaoProcessor.name);

  constructor(
    private readonly sgaAuthService: SgaAuthService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
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
      baseOrigin,
      nome,
      telefone_celular,
    } = job.data;

    this.logger.log(
      `[Job iniciado] verificar-boleto | jobId=${job.id} | attemptsMade=${job.attemptsMade} | nosso_numero=${nosso_numero} | codigo_veiculo=${codigo_veiculo} | baseOrigin=${baseOrigin} | temNome=${!!nome} | temTelefone=${!!telefone_celular}`,
    );

    const url = `https://api.hinova.com.br/api/sga/v2/processa-pdf/boleto`;

    this.logger.log(
      `Consultando status do boleto | nosso_numero=${nosso_numero} | url=${url}`,
    );

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
        `Erro ao verificar boleto | nosso_numero=${nosso_numero} | status=${response.status} | body=${JSON.stringify(response.data)}`,
      );
      return;
    }

    this.logger.debug(
      `Resposta raw processa-pdf/boleto | nosso_numero=${nosso_numero} | status=${response.status} | type=${Array.isArray(response.data) ? 'array' : typeof response.data} | body=${JSON.stringify(response.data)}`,
    );

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
          .filter(([key, value]) => /^\d+$/.test(key) && !!value && typeof value === 'object')
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
      boletos.find((item) => String(item?.nosso_numero) === String(nosso_numero)) ??
      boletos[0];

    const codigoSituacaoRaw = boletoInfo?.codigo_situacao_boleto;
    let codigoSituacao =
      codigoSituacaoRaw !== undefined && codigoSituacaoRaw !== null
        ? String(codigoSituacaoRaw)
        : undefined;

    this.logger.log(
      `Status do boleto verificado | nosso_numero=${nosso_numero} | codigo_situacao_boleto=${codigoSituacao ?? 'N/A'} | totalRegistros=${boletos.length} | registroSelecionado=${boletoInfo ? 'sim' : 'nao'} | keys=${Object.keys(boletoInfo ?? {}).join(', ')}`,
    );

    // Fallback: quando processa-pdf retorna vazio/N/A, consultar boletos por veículo
    if (!codigoSituacao) {
      const now = new Date();
      const dataInicial = new Date(now);
      dataInicial.setDate(now.getDate() - 45);
      const dataFinal = new Date(now);
      dataFinal.setDate(dataFinal.getDate() + 45);

      const fallbackBody = {
        codigo_veiculo: Number(codigo_veiculo),
        data_vencimento_original_inicial: formatDateBR(dataInicial),
        data_vencimento_original_final: formatDateBR(dataFinal),
      };

      this.logger.log(
        `Fallback de status ativado (listar/boleto-associado-veiculo) | nosso_numero=${nosso_numero} | codigo_veiculo=${codigo_veiculo}`,
      );
      this.logger.debug(
        `Payload fallback listar boleto | body=${JSON.stringify(fallbackBody)}`,
      );

      const fallbackResponse = await this.sgaAuthService.executeRequestWithAuth(
        baseOrigin,
        {
          method: 'POST',
          url: 'https://api.hinova.com.br/api/sga/v2/listar/boleto-associado-veiculo',
          data: fallbackBody,
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true,
        },
      );

      this.logger.debug(
        `Resposta fallback listar boleto | status=${fallbackResponse.status} | body=${JSON.stringify(fallbackResponse.data)}`,
      );

      if (fallbackResponse.status < 400 && Array.isArray(fallbackResponse.data)) {
        const boletoFallback = fallbackResponse.data.find(
          (item: { nosso_numero?: number | string }) =>
            String(item?.nosso_numero) === String(nosso_numero),
        );

        if (boletoFallback?.codigo_situacao_boleto !== undefined) {
          codigoSituacao = String(boletoFallback.codigo_situacao_boleto);
          boletoInfo = boletoFallback as BoletoInfo;
          this.logger.log(
            `Status recuperado via fallback | nosso_numero=${nosso_numero} | codigo_situacao_boleto=${codigoSituacao}`,
          );
        } else {
          this.logger.warn(
            `Fallback sem status para nosso_numero informado | nosso_numero=${nosso_numero} | encontrados=${fallbackResponse.data.length}`,
          );
        }
      } else {
        this.logger.warn(
          `Fallback retornou erro | nosso_numero=${nosso_numero} | status=${fallbackResponse.status}`,
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

      this.logger.log(
        `Pagamento de revistoria persistido (job) | userVehicleId=${userVehicleId} | nosso_numero=${nosso_numero} | situacao=${codigoSituacao ?? 'PENDENTE'} | pago=${pago}`,
      );
    } catch (persistError) {
      this.logger.error(
        `Falha ao persistir pagamento de revistoria (job) | userVehicleId=${userVehicleId} | nosso_numero=${nosso_numero}`,
        persistError instanceof Error ? persistError.stack : undefined,
      );
    }

    if (codigoSituacao !== '1' && codigoSituacao !== '4') {
      this.logger.log(
        `Boleto ainda n\u00e3o pago | nosso_numero=${nosso_numero} | situacao=${codigoSituacao ?? 'N/A'} | pr\u00f3xima verifica\u00e7\u00e3o em ~2min`,
      );
      return;
    }

    // Boleto pago/liquidado — reativar veículo (situação 1)
    this.logger.log(
      `Boleto pago! Reativando veículo | nosso_numero=${nosso_numero} | codigo_veiculo=${codigo_veiculo}`,
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
      );
    } catch (mailError) {
      this.logger.error(
        `Falha ao enviar e-mail de boleto pago | userVehicleId=${userVehicleId} | nosso_numero=${nosso_numero}`,
        mailError instanceof Error ? mailError.stack : undefined,
      );
    }

    const alterarUrl = `https://api.hinova.com.br/api/sga/v2/veiculo/alterar-situacao-para/1/${codigo_veiculo}`;

    const alterarResponse = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      { method: 'GET', url: alterarUrl, validateStatus: () => true },
    );

    this.logger.log(
      `Veículo reativado (situação 1) | codigo_veiculo=${codigo_veiculo} | status=${alterarResponse.status}`,
    );

    // Remover o job recorrente
    if (job.repeatJobKey) {
      await this.queue.removeRepeatableByKey(job.repeatJobKey);
      this.logger.log(
        `Job de verificação removido | nosso_numero=${nosso_numero} | repeatJobKey=${job.repeatJobKey}`,
      );
    }

    // Notificar usuário via Suri que o boleto foi pago
    if (nome && telefone_celular) {
      const primeiroNome = nome.trim().split(/\s+/)[0] ?? '';
      const primeiroNomeFormatado = primeiroNome
        ? `${primeiroNome.charAt(0).toUpperCase()}${primeiroNome.slice(1).toLowerCase()}`
        : '';
      const phoneNormalized = '55' + telefone_celular.replace(/\D/g, '');

      this.logger.log(
        `Enviando notificação Suri (boleto pago) | nosso_numero=${nosso_numero} | phone=${phoneNormalized} | primeiroNome=${primeiroNomeFormatado} | templateId=${process.env.suri_template_id_boleto_pago}`,
      );
      this.logger.debug(
        `Payload Suri (boleto pago) | suri_baseUrl=${process.env.suri_baseUrl} | nome=${nome}`,
      );

      try {
        const suriResponse = await axios.post(
          process.env.suri_baseUrl!,
          {
            user: {
              name: nome,
              phone: phoneNormalized,
              email: null,
              gender: 0,
              channelId: process.env.channelId,
              channelType: 1,
              defaultDepartmentId: null,
            },
            message: {
              templateId: process.env.suri_template_id_boleto_pago,
              BodyParameters: [primeiroNomeFormatado],
            },
            responseAction: {
              type: 1,
              sendTo: process.env.sendTo,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.token_suri}`,
              'Content-Type': 'application/json',
            },
            validateStatus: () => true,
          },
        );

        this.logger.log(
          `Notificação Suri (boleto pago) enviada | nosso_numero=${nosso_numero} | status=${suriResponse.status}`,
        );
        this.logger.debug(
          `Resposta Suri (boleto pago) | body=${JSON.stringify(suriResponse.data)}`,
        );
      } catch (suriError) {
        this.logger.error(
          `Falha ao enviar notificação Suri (boleto pago) | nosso_numero=${nosso_numero}`,
          suriError instanceof Error ? suriError.stack : undefined,
        );
      }
    } else {
      this.logger.warn(
        `Notificação Suri (boleto pago) não enviada — nome ou telefone ausente no job | nosso_numero=${nosso_numero} | temNome=${!!nome} | temTelefone=${!!telefone_celular}`,
      );
    }
  }
}
