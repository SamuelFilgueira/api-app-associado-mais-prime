import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { resolverTemplateRevistoria } from 'src/config/revistoria-regra.config';
import { PrismaService } from 'src/database/prisma.service';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import {
  RespostaComStatus,
  corpoDeErroDoSga,
  erroDaConsultaAoSga,
} from 'src/sga/helpers/erro-como-sucesso.helper';
import { VeiculosSincronizacaoService } from 'src/sga/services/veiculos-sincronizacao.service';

/** Campos de `GET /veiculo/buscar/:chassi` repassados ao app. */
interface VeiculoDoSga {
  codigo_veiculo?: unknown;
  chassi?: unknown;
  placa?: unknown;
  tipo?: unknown;
  categoria?: unknown;
  nome?: unknown;
}

/**
 * Veículo pelo chassi: dados do SGA usados pelo app na revistoria (tipo →
 * template de fotos) e a marca local de "revistoria exigida".
 *
 * Nenhuma das duas operações confere se o veículo é de quem pede (decisão
 * de produto); o formato do chassi é validado na borda, no controller.
 */
@Injectable()
export class SgaVeiculoInfoService {
  private readonly logger = new Logger(SgaVeiculoInfoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sgaAuthService: SgaAuthService,
    private readonly veiculosSincronizacao: VeiculosSincronizacaoService,
  ) {}

  /**
   * `baseOrigin` (do JWT) define a regra de template da revistoria; sem ele,
   * vale a base padrão do deploy. A consulta ao SGA usa a base do dono do
   * veículo e, se o veículo não estiver no cadastro local, a do JWT.
   */
  async consultarVeiculoInfo(chassi: string, baseOrigin?: BaseOrigin | null) {
    const normalizedChassi = chassi?.trim();
    if (!normalizedChassi) {
      throw new BadRequestException('Chassi é obrigatório');
    }

    try {
      const response = await this.buscarVeiculo(normalizedChassi, baseOrigin);
      if (response.status >= 400) {
        return corpoDeErroDoSga('sga/veiculos-info', response);
      }

      const veiculos = (
        Array.isArray(response.data)
          ? response.data
          : response.data
            ? [response.data]
            : []
      ) as Array<VeiculoDoSga | null | undefined>;

      return veiculos.map((veiculo) => ({
        codigo_veiculo: veiculo?.codigo_veiculo ?? null,
        chassi: veiculo?.chassi ?? null,
        placa: veiculo?.placa ?? null,
        tipo: veiculo?.tipo ?? null,
        categoria: veiculo?.categoria ?? null,
        nome: veiculo?.nome ?? null,
        // Template de fotos da revistoria para este tipo, pela regra da base.
        template_revistoria: resolverTemplateRevistoria(
          veiculo?.tipo,
          baseOrigin,
        ),
      }));
    } catch (error: unknown) {
      return erroDaConsultaAoSga(
        'sga/veiculos-info',
        error,
        'Erro ao consultar veículo no SGA',
      );
    }
  }

  async setRevistoria(chassi: string, reinspectionRequired: boolean) {
    const alterados = await this.veiculosSincronizacao.marcarRevistoria(
      chassi.trim(),
      reinspectionRequired,
    );
    if (alterados === 0) {
      throw new NotFoundException(
        'Veículo não encontrado para o chassi informado',
      );
    }
  }

  /**
   * `GET /veiculo/buscar/:chassi`. `baseDoToken` é a base de quem pede
   * (JWT): usada quando o veículo não tem dono no cadastro local. Sem
   * nenhuma das duas lança `BaseNaoResolvidaError` — nunca consulta o SGA
   * da base padrão.
   */
  private async buscarVeiculo(
    chassi: string,
    baseDoToken?: BaseOrigin | null,
  ): Promise<RespostaComStatus> {
    let baseDoDono: string | null | undefined;
    try {
      const userVehicle = await this.prisma.userVehicle.findFirst({
        where: { chassi },
        select: { user: { select: { baseOrigin: true } } },
      });
      baseDoDono = userVehicle?.user?.baseOrigin;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(
        `Falha ao resolver baseOrigin por chassi=${chassi}: ${message}`,
      );
    }

    const baseOrigin = exigirBase(
      baseDoDono || baseDoToken,
      'consulta do veículo no SGA',
    );
    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url: `${SGA_BASE_URL}/veiculo/buscar/${chassi}`,
      validateStatus: () => true,
      compartilharEmVoo: true,
    });
  }
}
