import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { TENANT } from 'src/config/tenant.config';
import { SgaAuthService } from 'src/shared/sga-auth.service';

function formatDateBR(date: Date) {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const ano = date.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

type BoletoApiVehicle = {
  codigo_veiculo?: string | number;
  placa?: string;
};

type BoletoApiItem = {
  nosso_numero?: unknown;
  linha_digitavel?: unknown;
  pix?: { copia_cola?: string | null } | null;
  link_boleto?: unknown;
  valor_boleto?: unknown;
  situacao_boleto?: unknown;
  data_vencimento?: unknown;
  data_pagamento?: unknown;
  codigo_veiculo?: string | number;
  veiculos?: BoletoApiVehicle[];
  [key: string]: unknown;
};

type BoletoListItem = {
  nosso_numero?: unknown;
  linha_digitavel?: unknown;
  pix?: string | null;
  link_boleto?: unknown;
  valor_boleto?: unknown;
  situacao_boleto?: unknown;
  data_vencimento?: unknown;
  data_pagamento?: unknown;
  placa?: string;
  [key: string]: unknown;
};

function normalizeVehicleCode(
  value: string | number | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

@Injectable()
export class BoletoService {
  private readonly logger = new Logger(BoletoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sgaAuthService: SgaAuthService,
  ) {}

  private async resolveVehicleContext(
    userId: number,
    codigoVeiculo: number,
    tokenBaseOrigin?: BaseOrigin,
  ): Promise<{ baseOrigin: BaseOrigin; vehicleBelongsToUser: boolean }> {
    try {
      const userVehicle = await this.prisma.userVehicle.findFirst({
        where: {
          userId,
          externalVehicleCode: String(codigoVeiculo),
          isActive: true,
        },
        select: { user: { select: { baseOrigin: true } } },
      });

      if (!userVehicle) {
        return {
          baseOrigin: tokenBaseOrigin ?? TENANT.defaultBase,
          vehicleBelongsToUser: false,
        };
      }

      if (tokenBaseOrigin) {
        return { baseOrigin: tokenBaseOrigin, vehicleBelongsToUser: true };
      }

      if (userVehicle.user?.baseOrigin) {
        return {
          baseOrigin: userVehicle.user.baseOrigin as BaseOrigin,
          vehicleBelongsToUser: true,
        };
      }

      return { baseOrigin: TENANT.defaultBase, vehicleBelongsToUser: true };
    } catch (error: unknown) {
      this.logger.warn(
        `Falha ao resolver contexto do veículo userId=${userId} codigo_veiculo=${codigoVeiculo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      baseOrigin: tokenBaseOrigin ?? TENANT.defaultBase,
      vehicleBelongsToUser: true,
    };
  }

  private extractVehicleCodes(boleto: BoletoApiItem): string[] {
    const requestedCode = normalizeVehicleCode(boleto.codigo_veiculo);
    const nestedCodes = Array.isArray(boleto.veiculos)
      ? boleto.veiculos
          .map((vehicle) => normalizeVehicleCode(vehicle?.codigo_veiculo))
          .filter((code): code is string => code !== null)
      : [];

    return requestedCode ? [requestedCode, ...nestedCodes] : nestedCodes;
  }

  private hasVehicleIdentifier(boleto: BoletoApiItem): boolean {
    return this.extractVehicleCodes(boleto).length > 0;
  }

  private belongsToVehicle(
    boleto: BoletoApiItem,
    codigoVeiculo: number,
  ): boolean {
    const expectedCode = normalizeVehicleCode(codigoVeiculo);

    if (!expectedCode) {
      return false;
    }

    return this.extractVehicleCodes(boleto).includes(expectedCode);
  }

  private mapBoletoItem(boleto: BoletoApiItem): BoletoListItem {
    return {
      nosso_numero: boleto.nosso_numero,
      linha_digitavel: boleto.linha_digitavel,
      pix: boleto.pix?.copia_cola ?? null,
      link_boleto: boleto.link_boleto,
      valor_boleto: boleto.valor_boleto,
      situacao_boleto: boleto.situacao_boleto,
      data_vencimento: boleto.data_vencimento,
      data_pagamento: boleto.data_pagamento,
      placa:
        Array.isArray(boleto.veiculos) && boleto.veiculos[0]
          ? boleto.veiculos[0].placa
          : undefined,
    };
  }

  private filterBoletosByVehicle(
    boletos: BoletoApiItem[],
    codigoVeiculo: number,
  ): BoletoApiItem[] {
    const boletosDoVeiculo = boletos.filter((boleto) =>
      this.belongsToVehicle(boleto, codigoVeiculo),
    );

    if (boletosDoVeiculo.length > 0) {
      if (boletosDoVeiculo.length !== boletos.length) {
        this.logger.warn(
          `Hinova retornou boletos misturados para codigo_veiculo=${codigoVeiculo}. total=${boletos.length} filtrados=${boletosDoVeiculo.length}`,
        );
      }

      return boletosDoVeiculo;
    }

    const hasAnyVehicleIdentifier = boletos.some((boleto) =>
      this.hasVehicleIdentifier(boleto),
    );

    if (hasAnyVehicleIdentifier) {
      this.logger.warn(
        `Hinova retornou boletos sem correspondência para codigo_veiculo=${codigoVeiculo}. total=${boletos.length}`,
      );
      return [];
    }

    this.logger.warn(
      `Resposta da Hinova sem identificador de veículo para codigo_veiculo=${codigoVeiculo}. Mantendo itens sem filtro defensivo. total=${boletos.length}`,
    );
    return boletos;
  }

  async consultarBoletosPorVeiculo(
    userId: number,
    codigo_veiculo: number,
    tokenBaseOrigin?: BaseOrigin,
  ) {
    const { baseOrigin, vehicleBelongsToUser } = await this.resolveVehicleContext(
      userId,
      codigo_veiculo,
      tokenBaseOrigin,
    );

    if (!vehicleBelongsToUser) {
      this.logger.warn(
        `Bloqueando listagem de boletos para veículo sem vínculo com o usuário. userId=${userId} codigo_veiculo=${codigo_veiculo}`,
      );
      return [];
    }

    const now = new Date();
    const dataInicial = new Date(now);
    dataInicial.setDate(now.getDate() - 45);
    const dataFinal = new Date(now);
    dataFinal.setDate(dataFinal.getDate() + 45);
    const dataInicialStr = formatDateBR(dataInicial);
    const dataFinalStr = formatDateBR(dataFinal);
    const body = {
      codigo_veiculo,
      //codigo_situacao_boleto: '2',
      data_vencimento_original_inicial: dataInicialStr,
      data_vencimento_original_final: dataFinalStr,
    };

    try {
      const response =
        await this.sgaAuthService.executeRequestWithAuth<unknown>(baseOrigin, {
          method: 'POST',
          url: 'https://api.hinova.com.br/api/sga/v2/listar/boleto-associado-veiculo',
          data: body,
          headers: {
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        });

      //his.logger.log(`Resposta da API de boletos para veículo ${codigo_veiculo}: status=${response.status} body=${JSON.stringify(response.data)}`);

      if (response.status === 200 && Array.isArray(response.data)) {
        const boletosDaHinova = response.data.filter(
          (item): item is BoletoApiItem => !!item && typeof item === 'object',
        );

        return this.filterBoletosByVehicle(boletosDaHinova, codigo_veiculo).map(
          (boleto) => this.mapBoletoItem(boleto),
        );
      }

      return response.data && typeof response.data === 'object'
        ? [response.data as Record<string, unknown>]
        : [];
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data && typeof error.response.data === 'object'
          ? [error.response.data as Record<string, unknown>]
          : [];
      }
      throw new InternalServerErrorException(
        'Erro ao consultar boletos na Hinova',
      );
    }
  }
}
