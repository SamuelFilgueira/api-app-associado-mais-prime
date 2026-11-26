import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { situacaoExigeRevistoria } from 'src/config/revistoria-regra.config';
import { PrismaService } from 'src/database/prisma.service';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import {
  listaDeVeiculosDoSga,
  removerVeiculosInativos,
  veiculoInativoNoSga,
} from 'src/sga/domain/veiculo-sga';
import {
  RespostaComStatus,
  contarErroComoSucesso,
  corpoDeErroDoSga,
  erroDaConsultaAoSga,
} from 'src/sga/helpers/erro-como-sucesso.helper';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { VeiculosSincronizacaoService } from 'src/sga/services/veiculos-sincronizacao.service';

/**
 * Consultas do app ao associado no SGA (Hinova): o cadastro com os veículos
 * (`/sga/associado`) e só os veículos (`/sga/veiculos`). As duas leem o
 * mesmo `associado/buscar`, pela leitura com cache da Hinova.
 *
 * O contrato com o app é antigo e não muda: quando o SGA responde erro, o
 * corpo do erro volta ao app com HTTP 200 (e conta na métrica — ver
 * `erro-como-sucesso.helper.ts`).
 */
@Injectable()
export class SgaConsultaService {
  private readonly logger = new Logger(SgaConsultaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hinova: HinovaClient,
    private readonly associadoSincronizacao: AssociadoSincronizacaoService,
    private readonly veiculosSincronizacao: VeiculosSincronizacaoService,
  ) {}

  async consultarAssociado(userId: number) {
    const usuario = await this.getUserParaSga(userId);
    try {
      const response = await this.buscarAssociado(
        usuario.cpf,
        usuario.baseOrigin ?? undefined,
      );
      if (response.status === 406) {
        contarErroComoSucesso('sga/associado');
        return response.data;
      }
      if (response.status >= 400) {
        return corpoDeErroDoSga('sga/associado', response);
      }
      // Reaproveita o corpo já obtido para alinhar o cadastro local ao SGA,
      // em segundo plano: não bloqueia nem altera a resposta ao app.
      this.associadoSincronizacao.sincronizarEmSegundoPlano(
        usuario,
        response.data,
      );
      // Veículos INATIVOS no SGA não são expostos ao associado.
      return removerVeiculosInativos(response.data);
    } catch (error: unknown) {
      return erroDaConsultaAoSga(
        'sga/associado',
        error,
        'Erro ao consultar SGA',
      );
    }
  }

  async consultarVeiculosAssociado(userId: number) {
    const usuario = await this.getUserParaSga(userId);
    try {
      const response = await this.buscarAssociado(
        usuario.cpf,
        usuario.baseOrigin ?? undefined,
      );
      if (response.status >= 400) {
        return corpoDeErroDoSga('sga/veiculos', response);
      }

      // Um 2xx sem a lista de veículos (corpo de erro, HTML de proxy, JSON
      // truncado) não é "associado sem veículos". Sincronizar com ele
      // desativava todos os veículos do usuário (`notIn: []`).
      const doSga = listaDeVeiculosDoSga(response.data);
      if (!doSga) {
        contarErroComoSucesso('sga/veiculos');
        this.logger.error(
          `Resposta do SGA sem lista de veículos (HTTP ${response.status}) para userId=${userId}; sincronização ignorada, veículos locais mantidos.`,
        );
        return [];
      }

      // Mesmo corpo do SGA de /sga/associado: alinha o cadastro local também
      // por esta rota, pois o app pode abrir consultando só os veículos.
      this.associadoSincronizacao.sincronizarEmSegundoPlano(
        usuario,
        response.data,
      );

      // Veículos INATIVOS no SGA são descartados aqui: não voltam ao app e,
      // por não entrarem na sincronização, ficam com isActive=false.
      const veiculos = doSga.filter((v) => !veiculoInativoNoSga(v));
      await this.veiculosSincronizacao.sincronizar(userId, veiculos);

      // Retorna apenas o array de veículos (mantém resposta para frontend).
      // `revistoria_obrigatoria` é aditivo: aplica a regra de revistoria da
      // base do associado (src/config/revistoria-regra.config.ts).
      return veiculos.map((v) => ({
        ...v,
        revistoria_obrigatoria: situacaoExigeRevistoria(
          v.descricao_situacao ?? v.situacao,
          usuario.baseOrigin,
        ),
      }));
    } catch (error: unknown) {
      return erroDaConsultaAoSga(
        'sga/veiculos',
        error,
        'Erro ao consultar veículos do associado',
      );
    }
  }

  /**
   * Recorte do usuário usado nas consultas ao SGA: CPF limpo (somente
   * dígitos), base de origem e os campos cadastrais comparados pela
   * sincronização com o SGA (uma única leitura no banco).
   */
  private async getUserParaSga(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        cpf: true,
        baseOrigin: true,
        name: true,
        email: true,
        cep: true,
        address: true,
      },
    });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    return { ...user, cpf: user.cpf.replace(/\D/g, '') };
  }

  /**
   * `GET /associado/buscar/:cpf`, pela leitura com cache da Hinova. A base
   * é a do usuário; sem ela, tenta a do cadastro com o mesmo CPF. Sem base
   * válida lança `BaseNaoResolvidaError` antes de falar com o SGA — nunca
   * usa a base padrão.
   */
  private async buscarAssociado(
    cpf: string,
    baseDoUsuario?: BaseOrigin,
  ): Promise<RespostaComStatus> {
    let baseDoCadastro: string | null | undefined;

    if (!baseDoUsuario) {
      // Obs.: pode falhar se o CPF estiver armazenado com formatação diferente
      try {
        const user = await this.prisma.user.findFirst({ where: { cpf } });
        baseDoCadastro = user?.baseOrigin;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'erro desconhecido';
        this.logger.warn(`Falha ao resolver baseOrigin por CPF: ${message}`);
      }
    }

    const baseOrigin = exigirBase(
      baseDoUsuario || baseDoCadastro,
      'consulta do associado no SGA',
    );
    return this.hinova.buscarAssociado(baseOrigin, cpf);
  }
}
