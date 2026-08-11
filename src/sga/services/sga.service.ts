import {
  BadRequestException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import axios from 'axios';
import { PrismaService } from 'src/database/prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { TENANT } from 'src/config/tenant.config';
import { SgaAuthService } from 'src/shared/sga-auth.service';
import { debugLog } from 'src/shared/debug-log.util';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';

type SgaVeiculo = {
  chassi?: string;
  placa?: string;
  codigo_veiculo?: string | number;
};

type SgaAssociadoResponse = {
  veiculos?: SgaVeiculo[];
};

@Injectable()
export class SgaService {
  private readonly logger = new Logger(SgaService.name);

  constructor(
    private prisma: PrismaService,
    private sgaAuthService: SgaAuthService,
    @InjectQueue(BOLETO_VERIFICACAO_QUEUE as string)
    private readonly boletoVerificacaoQueue: Queue,
  ) {}

  /**
   * Busca o CPF limpo (somente dígitos) de um usuário pelo ID
   */
  private async getUserCpf(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    return user.cpf.replace(/\D/g, '');
  }

  /**
   * Realiza chamada à API SGA da Hinova para buscar dados do associado.
   * Quando `baseOriginOverride` é fornecido, ele é usado diretamente,
   * evitando o relookup de CPF no banco que pode falhar por diferença de formatação.
   */
  private async fetchSgaAssociado(
    cpf: string,
    baseOriginOverride?: BaseOrigin,
  ) {
    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;

    let baseOrigin: BaseOrigin = baseOriginOverride ?? TENANT.defaultBase;

    if (!baseOriginOverride) {
      // Fallback: tenta resolver baseOrigin pelo CPF no banco
      // Obs.: pode falhar se o CPF estiver armazenado com formatação diferente
      try {
        const user = await this.prisma.user.findFirst({ where: { cpf } });
        if (user?.baseOrigin) baseOrigin = user.baseOrigin as BaseOrigin;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'erro desconhecido';
        this.logger.warn(
          `Falha ao resolver baseOrigin por cpf=${cpf}: ${message}`,
        );
      }
    }

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
    });
  }

  private async fetchSgaVeiculo(chassi: string) {
    const url = `https://api.hinova.com.br/api/sga/v2/veiculo/buscar/${chassi}`;

    // try to determine baseOrigin from vehicle owner
    let baseOrigin: BaseOrigin = TENANT.defaultBase;
    try {
      const userVehicle = await this.prisma.userVehicle.findFirst({
        where: { chassi },
        select: { user: { select: { baseOrigin: true } } },
      });
      if (userVehicle?.user?.baseOrigin) {
        baseOrigin = userVehicle.user.baseOrigin as BaseOrigin;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(
        `Falha ao resolver baseOrigin por chassi=${chassi}: ${message}`,
      );
    }

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
    });
  }

  async consultarAssociado(userId: number) {
    const cpf = await this.getUserCpf(userId);
    try {
      const response = await this.fetchSgaAssociado(cpf);
      if (response.status === 406) {
        return response.data;
      }
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }
      return response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException('Erro ao consultar SGA');
    }
  }

  async consultarVeiculosAssociado(userId: number) {
    const cpf = await this.getUserCpf(userId);
    try {
      const response = await this.fetchSgaAssociado(cpf);
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }

      // Persistência local dos veículos
      const data = response.data as SgaAssociadoResponse | null | undefined;
      const veiculos = Array.isArray(data?.veiculos) ? data.veiculos : [];
      const now = new Date();
      const upsertedChassis = new Set<string>();

      // Upsert all vehicles
      for (const v of veiculos) {
        if (!v.chassi) continue; // skip invalid
        upsertedChassis.add(String(v.chassi));
        await this.prisma.userVehicle.upsert({
          where: {
            userId_chassi: {
              userId: userId,
              chassi: v.chassi,
            },
          },
          update: {
            plate: v.placa || null,
            externalVehicleCode: v.codigo_veiculo
              ? String(v.codigo_veiculo)
              : null,
            isActive: true,
            lastSyncAt: now,
          },
          create: {
            userId: userId,
            chassi: v.chassi,
            plate: v.placa || null,
            externalVehicleCode: v.codigo_veiculo
              ? String(v.codigo_veiculo)
              : null,
            isActive: true,
            lastSyncAt: now,
          },
        });
      }

      // Mark as inactive any vehicles not present in the latest sync
      await this.prisma.userVehicle.updateMany({
        where: {
          userId: userId,
          chassi: { notIn: Array.from(upsertedChassis) },
          isActive: true,
        },
        data: {
          isActive: false,
          lastSyncAt: now,
        },
      });

      // Retorna apenas o array de veículos (mantém resposta para frontend)
      return veiculos;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException(
        'Erro ao consultar veículos do associado',
      );
    }
  }

  async consultarVeiculoInfo(chassi: string) {
    const normalizedChassi = chassi?.trim();

    if (!normalizedChassi) {
      throw new BadRequestException('Chassi é obrigatório');
    }

    try {
      const response = await this.fetchSgaVeiculo(normalizedChassi);
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }

      const veiculos = Array.isArray(response.data)
        ? response.data
        : response.data
          ? [response.data]
          : [];

      return veiculos.map((veiculo) => ({
        codigo_veiculo: veiculo?.codigo_veiculo ?? null,
        chassi: veiculo?.chassi ?? null,
        placa: veiculo?.placa ?? null,
        tipo: veiculo?.tipo ?? null,
        categoria: veiculo?.categoria ?? null,
        nome: veiculo?.nome ?? null,
      }));
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException(
        'Erro ao consultar veículo no SGA',
      );
    }
  }

  async setRevistoria(chassi: string, reinspectionRequired: boolean) {
    const normalizedChassi = chassi.trim();

    const result = await this.prisma.userVehicle.updateMany({
      where: {
        chassi: normalizedChassi,
      },
      data: {
        reinspectionRequired,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException(
        'Veículo não encontrado para o chassi informado',
      );
    }

    return;
  }

  private async fetchProdutosVinculadosVeiculo(
    placa: string,
    baseOrigin: BaseOrigin,
  ) {
    const url = `https://api.hinova.com.br/api/sga/v2/produto-vinculado-veiculo/listar/${placa}`;

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
    });
  }

  private async alterarSituacaoVeiculo(
    codigoSituacao: number,
    codigoVeiculo: string,
    baseOrigin: BaseOrigin,
  ) {
    const url = `https://api.hinova.com.br/api/sga/v2/veiculo/alterar-situacao-para/${codigoSituacao}/${codigoVeiculo}`;

    const response = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      { method: 'GET', url, validateStatus: () => true },
    );

    if (response.status >= 400) {
      throw new InternalServerErrorException(
        `Erro ao alterar situação do veículo: ${JSON.stringify(response.data)}`,
      );
    }

    return response.data;
  }

  async criarBoletoReativacao(
    userVehicleId: number,
    plate: string,
    debugId?: string,
  ): Promise<void> {
    // 1. Resolve CPF e baseOrigin a partir do veículo
    const userVehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: {
        user: {
          select: {
            cpf: true,
            baseOrigin: true,
          },
        },
      },
    });

    if (!userVehicle?.user?.cpf) {
      throw new NotFoundException('CPF não encontrado para o veículo');
    }

    const cpf = userVehicle.user.cpf.replace(/\D/g, '');
    const baseOrigin: BaseOrigin =
      (userVehicle.user.baseOrigin as BaseOrigin) ?? TENANT.defaultBase;

    // 2. Buscar dados do associado (codigo_associado, codigo_regional)
    // Passa baseOrigin explicitamente para evitar resolução errada por CPF formatado
    const associadoResponse = await this.fetchSgaAssociado(cpf, baseOrigin);

    if (associadoResponse.status >= 400) {
      this.logger.error(
        debugLog(SgaService.name, 'Erro ao buscar associado', debugId, {
          userVehicleId,
          status: associadoResponse.status,
          body: associadoResponse.data,
        }),
      );
      throw new InternalServerErrorException(
        'Erro ao buscar dados do associado para criação do boleto',
      );
    }

    // A API pode retornar objeto direto ou array com um elemento
    const rawAssociadoData = Array.isArray(associadoResponse.data)
      ? (associadoResponse.data[0] ?? {})
      : (associadoResponse.data ?? {});

    const associadoData = rawAssociadoData as {
      codigo_associado?: number;
      codigo_regional?: number;
      nome?: string;
      telefone_celular?: string;
    };

    const { codigo_associado, codigo_regional, nome, telefone_celular } =
      associadoData;

    // 3. Buscar produtos vinculados ao veículo (valor_total_produtos_ativo_reais, taxa_administrativa, codigo_veiculo)
    const produtosResponse = await this.fetchProdutosVinculadosVeiculo(
      plate,
      baseOrigin,
    );

    if (produtosResponse.status >= 400) {
      this.logger.error(
        debugLog(SgaService.name, 'Erro ao buscar produtos do veículo', debugId, {
          userVehicleId,
          placa: plate,
          status: produtosResponse.status,
          body: produtosResponse.data,
        }),
      );
      throw new InternalServerErrorException(
        'Erro ao buscar produtos vinculados ao veículo',
      );
    }

    // A API pode retornar objeto direto ou array com um elemento
    const rawProdutosData = Array.isArray(produtosResponse.data)
      ? (produtosResponse.data[0] ?? {})
      : (produtosResponse.data ?? {});

    const produtosData = rawProdutosData as {
      valor_total_produtos_ativo_reais?: number;
      taxa_administrativa?: string;
      codigo_veiculo?: string;
    };

    const {
      valor_total_produtos_ativo_reais,
      taxa_administrativa,
      codigo_veiculo,
    } = produtosData;

    // 4. Calcular valor total (taxa_administrativa pode ser negativo via valor_total_produtos_ativo_reais)
    const totalValue =
      parseFloat(taxa_administrativa ?? '0') +
      (valor_total_produtos_ativo_reais ?? 0);

    const formattedValue = totalValue.toFixed(2).replace('.', ',');

    // 5. Montar datas
    const now = new Date();
    const mesReferente = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const vencimento = `${String(tomorrow.getDate()).padStart(2, '0')}/${String(tomorrow.getMonth() + 1).padStart(2, '0')}/${tomorrow.getFullYear()}`;

    // 6. Cadastrar boleto
    const boletoUrl = `https://api.hinova.com.br/api/sga/v2/boleto/cadastrar`;
    const boletoPayload = {
      codigo_associado,
      codigo_regional,
      codigo_situacao: '2',
      mes_referente: mesReferente,
      link_boleto: true,
      codigo_tipo_boleto: 2,
      array_parcela: [
        {
          valor: formattedValue,
          vencimento,
        },
      ],
      referencia: [
        {
          modulo: 'veiculo',
          codigo_modulo: codigo_veiculo,
          descricao: 'Boleto reativação app',
          valor: formattedValue,
        },
      ],
    };

    const boletoResponse = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      {
        method: 'POST',
        url: boletoUrl,
        data: boletoPayload,
        headers: {
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      },
    );

    if (boletoResponse.status >= 400) {
      throw new InternalServerErrorException(
        `Erro ao cadastrar boleto de reativação: ${JSON.stringify(boletoResponse.data)}`,
      );
    }

    // 7. Extrair nosso_numero, linha_digitavel e link_boleto da resposta do boleto
    // Suporta todos os formatos conhecidos da Hinova:
    //   - array direto: [{nosso_numero, linha_digitavel, link_boleto}]
    //   - objeto com dados_boleto_inserido: {dados_boleto_inserido: [{...}]}
    //   - objeto com chave numérica: {"0": {...}, mensagem: "OK"}
    type BoletoCadastradoItem = {
      nosso_numero?: number | string;
      linha_digitavel?: string;
      link_boleto?: string;
      [key: string]: unknown;
    };

    const normalizeBoletoResponse = (input: unknown): BoletoCadastradoItem[] => {
      if (!input) return [];
      if (Array.isArray(input)) {
        return input.filter(
          (item): item is BoletoCadastradoItem => !!item && typeof item === 'object',
        );
      }
      if (typeof input === 'object') {
        const record = input as Record<string, unknown>;
        if (Array.isArray(record.dados_boleto_inserido)) {
          return record.dados_boleto_inserido.filter(
            (item): item is BoletoCadastradoItem => !!item && typeof item === 'object',
          );
        }
        const numericKeyItems = Object.entries(record)
          .filter(
            ([key, value]) =>
              /^\d+$/.test(key) && !!value && typeof value === 'object',
          )
          .map(([, value]) => value as BoletoCadastradoItem);
        if (numericKeyItems.length > 0) return numericKeyItems;
      }
      return [];
    };

    const boletosNormalizados = normalizeBoletoResponse(boletoResponse.data);
    const boletoDados = boletosNormalizados[0];

    if (!boletoDados) {
      this.logger.warn(
        `Dados do boleto ausentes em todos os formatos | userVehicleId=${userVehicleId} | rawKeys=${Object.keys((boletoResponse.data as Record<string, unknown>) ?? {}).join(', ')} | rawBody=${JSON.stringify(boletoResponse.data)}`,
      );
    }

    const nossoNumero =
      boletoDados?.nosso_numero !== undefined && boletoDados.nosso_numero !== null
        ? Number(boletoDados.nosso_numero)
        : undefined;
    const linhaDigitavel = boletoDados?.linha_digitavel;
    const linkBoleto = boletoDados?.link_boleto;

    // 8.1 Persistir estado inicial do pagamento da revistoria
    try {
      const nossoNumeroString =
        nossoNumero !== undefined && nossoNumero !== null
          ? String(nossoNumero)
          : null;

      if (nossoNumeroString) {
        await this.prisma.reinspectionPayment.upsert({
          where: { nossoNumero: nossoNumeroString },
          update: {
            linhaDigitavel: linhaDigitavel ?? null,
            linkBoleto: linkBoleto ?? null,
            situacaoBoleto: 'CRIADO',
            pago: false,
            pagoEm: null,
          },
          create: {
            userVehicleId,
            nossoNumero: nossoNumeroString,
            linhaDigitavel: linhaDigitavel ?? null,
            linkBoleto: linkBoleto ?? null,
            situacaoBoleto: 'CRIADO',
            boletoCriadoEm: new Date(),
            pago: false,
          },
        });
      } else {
        await this.prisma.reinspectionPayment.create({
          data: {
            userVehicleId,
            linhaDigitavel: linhaDigitavel ?? null,
            linkBoleto: linkBoleto ?? null,
            situacaoBoleto: 'CRIADO',
            boletoCriadoEm: new Date(),
            pago: false,
          },
        });
      }
    } catch (paymentPersistError) {
      this.logger.error(
        debugLog(SgaService.name, 'Falha ao persistir pagamento de revistoria (inicial)', debugId, {
          userVehicleId,
          nossoNumero: nossoNumero ?? 'N/A',
          error: paymentPersistError instanceof Error ? paymentPersistError.message : String(paymentPersistError),
        }),
      );
    }

    // 9. Alterar situação do veículo para 20
    if (codigo_veiculo) {
      try {
        await this.alterarSituacaoVeiculo(20, codigo_veiculo, baseOrigin);
      } catch (alterarError) {
        this.logger.error(
          `Falha ao alterar situação do veículo para 20 | codigo_veiculo=${codigo_veiculo}`,
          alterarError instanceof Error ? alterarError.stack : undefined,
        );
      }
    }

    // 10. Disparar job recorrente (2min) para verificar pagamento do boleto
    if (nossoNumero && codigo_veiculo) {
      await this.boletoVerificacaoQueue.add(
        'verificar-boleto',
        {
          userVehicleId,
          nosso_numero: nossoNumero,
          codigo_veiculo,
          codigo_associado,
          baseOrigin,
          nome,
          telefone_celular,
          debugId,
        },
        {
          repeat: { every: 120_000 },
          jobId: `boleto-verificacao-${nossoNumero}`,
        },
      );
    }

    // 11. Enviar notificação via Suri com o link do boleto
    if (linkBoleto) {
      try {
        const primeiroNome = (nome ?? '').trim().split(/\s+/)[0] ?? '';
        const primeiroNomeFormatado = primeiroNome
          ? `${primeiroNome.charAt(0).toUpperCase()}${primeiroNome.slice(1).toLowerCase()}`
          : '';
        const phoneNormalized =
          '55' + (telefone_celular ?? '').replace(/\D/g, '');

        await axios.post(
          process.env.suri_baseUrl!,
          {
            user: {
              name: nome ?? '',
              phone: phoneNormalized,
              email: null,
              gender: 0,
              channelId: process.env.channelId,
              channelType: 1,
              defaultDepartmentId: null,
            },
            message: {
              templateId: process.env.suri_template_id,
              BodyParameters: [primeiroNomeFormatado, linkBoleto],
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

      } catch (suriError) {
        this.logger.error(
          debugLog(SgaService.name, 'Falha ao enviar notificação Suri', debugId, {
            userVehicleId,
            error: suriError instanceof Error ? suriError.message : String(suriError),
          }),
        );
      }
    } else {
      this.logger.warn(
        debugLog(SgaService.name, 'link_boleto não encontrado na resposta do boleto', debugId, {
          userVehicleId,
          nossoNumero: nossoNumero ?? 'N/A',
          rawData: boletoResponse.data,
        }),
      );
    }
  }
}
