import {
  Injectable,
  Logger,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from 'src/database/prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { contarErroComoSucesso } from 'src/sga/helpers/erro-como-sucesso.helper';
import { janelaVencimentoBoleto } from 'src/sga/helpers/janela-boleto.helper';

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

/**
 * Posse do veículo e base a usar na Hinova. Sem posse não há base: o
 * chamador responde lista vazia e nenhuma credencial é usada.
 */
type VehicleContext =
  | { vehicleBelongsToUser: false }
  | { vehicleBelongsToUser: true; baseOrigin: BaseOrigin };

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
    private readonly hinova: HinovaClient,
  ) {}

  private async resolveVehicleContext(
    userId: number,
    codigoVeiculo: number,
    tokenBaseOrigin?: BaseOrigin,
  ): Promise<VehicleContext> {
    let baseDoCadastro: string | null | undefined;

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
        return { vehicleBelongsToUser: false };
      }

      baseDoCadastro = userVehicle.user?.baseOrigin;
    } catch (error: unknown) {
      // Falha de infraestrutura nunca concede posse: antes, um erro de banco
      // devolvia `vehicleBelongsToUser: true` e os boletos de qualquer
      // veículo saíam para quem pedisse.
      this.logger.error(
        `Falha ao resolver contexto do veículo userId=${userId} codigo_veiculo=${codigoVeiculo}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível consultar os boletos no momento. Tente novamente em instantes.',
      );
    }

    // Fora do `try`: base não resolvida é problema de cadastro
    // (`BaseNaoResolvidaError`), não indisponibilidade (503). A base vem do
    // token; sem ela, do cadastro do dono — nunca da base padrão.
    return {
      vehicleBelongsToUser: true,
      baseOrigin: exigirBase(
        tokenBaseOrigin || baseDoCadastro,
        'boletos do veículo',
      ),
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
    const contexto = await this.resolveVehicleContext(
      userId,
      codigo_veiculo,
      tokenBaseOrigin,
    );

    if (!contexto.vehicleBelongsToUser) {
      this.logger.warn(
        `Bloqueando listagem de boletos para veículo sem vínculo com o usuário. userId=${userId} codigo_veiculo=${codigo_veiculo}`,
      );
      return [];
    }

    const { baseOrigin } = contexto;
    const { dataInicialStr, dataFinalStr } = janelaVencimentoBoleto();
    const body = {
      codigo_veiculo,
      //codigo_situacao_boleto: '2',
      data_vencimento_original_inicial: dataInicialStr,
      data_vencimento_original_final: dataFinalStr,
    };

    try {
      // Leitura com cache: a lista é a mesma por alguns minutos, e quem gera
      // boleto ou detecta pagamento invalida a chave do veículo.
      const response = await this.hinova.listarBoletosDoVeiculo(
        baseOrigin,
        body,
      );

      if (response.status === 200 && Array.isArray(response.data)) {
        const boletosDaHinova = response.data.filter(
          (item): item is BoletoApiItem => !!item && typeof item === 'object',
        );

        return this.filterBoletosByVehicle(boletosDaHinova, codigo_veiculo).map(
          (boleto) => this.mapBoletoItem(boleto),
        );
      }

      // Contrato legado: o erro do SGA volta ao app dentro da lista, com
      // o status de sucesso da rota.
      contarErroComoSucesso('sga/boleto/listar');
      return response.data && typeof response.data === 'object'
        ? [response.data as Record<string, unknown>]
        : [];
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        contarErroComoSucesso('sga/boleto/listar');
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
