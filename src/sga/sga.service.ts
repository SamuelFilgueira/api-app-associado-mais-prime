import {
  BadRequestException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { SgaAuthService } from 'src/shared/sga-auth.service';
import { baseTag } from 'src/shared/log.util';

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
   * Realiza chamada à API SGA da Hinova para buscar dados do associado
   */
  private async fetchSgaAssociado(cpf: string) {
    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;

    // resolve baseOrigin from DB if possible
    let baseOrigin: BaseOrigin = 'MAIS_PRIME';
    try {
      const user = await this.prisma.user.findFirst({ where: { cpf } });
      if (user?.baseOrigin) baseOrigin = user.baseOrigin as BaseOrigin;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(
        `Falha ao resolver baseOrigin por cpf=${cpf}: ${message}`,
      );
    }

    this.logger.log(
      `${baseTag(baseOrigin)} consultando associado com autenticação dinâmica`,
    );

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
    });
  }

  private async fetchSgaVeiculo(chassi: string) {
    const url = `https://api.hinova.com.br/api/sga/v2/veiculo/buscar/${chassi}`;

    // try to determine baseOrigin from vehicle owner
    let baseOrigin: BaseOrigin = 'MAIS_PRIME';
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

    this.logger.log(
      `${baseTag(baseOrigin)} consultando veículo com autenticação dinâmica`,
    );

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

    this.logger.log(
      `${baseTag(baseOrigin)} consultando produtos vinculados ao veículo | placa=${placa}`,
    );

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
    });
  }

  async criarBoletoReativacao(
    userVehicleId: number,
    plate: string,
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
      (userVehicle.user.baseOrigin as BaseOrigin) ?? 'MAIS_PRIME';

    // 2. Buscar dados do associado (codigo_associado, codigo_regional)
    const associadoResponse = await this.fetchSgaAssociado(cpf);

    if (associadoResponse.status >= 400) {
      throw new InternalServerErrorException(
        'Erro ao buscar dados do associado para criação do boleto',
      );
    }

    const associadoData = associadoResponse.data as {
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
      throw new InternalServerErrorException(
        'Erro ao buscar produtos vinculados ao veículo',
      );
    }

    const produtosData = produtosResponse.data as {
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

    this.logger.debug(
      `Criando boleto de reativação | userVehicleId=${userVehicleId} | placa=${plate} | valor=${formattedValue}`,
    );

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

    this.logger.log(
      `Boleto de reativação cadastrado | userVehicleId=${userVehicleId} | status=${boletoResponse.status}`,
    );

    if (boletoResponse.status >= 400) {
      throw new InternalServerErrorException(
        `Erro ao cadastrar boleto de reativação: ${JSON.stringify(boletoResponse.data)}`,
      );
    }

    // 7. Enviar notificação via Suri com o link do boleto
    const boletoData = boletoResponse.data as {
      '0'?: { link_boleto?: string };
    };
    const linkBoleto = boletoData?.['0']?.link_boleto;

    if (linkBoleto) {
      try {
        const primeiroNome = (nome ?? '').split(' ')[0];
        const phoneNormalized =
          '55' + (telefone_celular ?? '').replace(/\D/g, '');

        const suriResponse = await axios.post(
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
              BodyParameters: [primeiroNome, linkBoleto],
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
          `Notificação Suri enviada | userVehicleId=${userVehicleId} | phone=${phoneNormalized} | status=${suriResponse.status}`,
        );
        this.logger.debug(
          `Resposta Suri | userVehicleId=${userVehicleId} | body=${JSON.stringify(suriResponse.data)}`,
        );
      } catch (suriError) {
        this.logger.error(
          `Falha ao enviar notificação Suri | userVehicleId=${userVehicleId}`,
          suriError instanceof Error ? suriError.stack : undefined,
        );
      }
    } else {
      this.logger.warn(
        `link_boleto não encontrado na resposta do boleto | userVehicleId=${userVehicleId}`,
      );
    }
  }
}
