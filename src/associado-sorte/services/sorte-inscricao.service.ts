import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SorteInscricao, SorteInscricaoFonte } from '@prisma/client';
import { isTenantBase } from 'src/config/tenant.config';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';
import {
  ListarInscricoesQuery,
  MarcarInscricaoDto,
} from 'src/associado-sorte/dto/inscricao.dto';
import { SorteAutor } from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import {
  produtoInscreve,
  veiculosCandidatos,
} from 'src/associado-sorte/helpers/sorte-inscricao.helper';
import {
  mascararCpf,
  metaPaginacao,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  SorteConfigView,
  toInscricaoView,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteInscricoesRepository } from 'src/associado-sorte/repositories/sorte-inscricoes.repository';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';
import { baseTag } from 'src/shared/log.util';

export type MotivoNaoInscrito = 'NAO_INSCRITO' | 'VERIFICACAO_INDISPONIVEL';

export interface SituacaoInscricao {
  inscrito: boolean;
  /** `null` quando inscrito. */
  motivo: MotivoNaoInscrito | null;
  fonte: SorteInscricaoFonte | null;
  verificadoEm: Date | null;
}

interface ResultadoSga {
  inscrito: boolean;
  codigoVeiculo: string | null;
}

/**
 * Inscrição no produto "Associado da Sorte" do SGA (seção 2.1). Um associado
 * = um participante (chave `userId`), mesmo com vários veículos inscritos.
 *
 * Cache em `SorteInscricao` com validade configurável; se o SGA falhar, vale
 * o último valor; sem nenhum, `VERIFICACAO_INDISPONIVEL`. A marcação manual
 * do painel (`MANUAL`) prevalece e nunca chama o SGA.
 */
@Injectable()
export class SorteInscricaoService {
  private readonly logger = new Logger(SorteInscricaoService.name);
  /** Verificações em andamento por associado (dedupe no processo). */
  private readonly emVoo = new Map<number, Promise<ResultadoSga>>();
  /** Depois de uma falha, espera um pouco antes de chamar o SGA de novo. */
  private readonly esperaAte = new Map<number, number>();

  constructor(
    private readonly repository: SorteInscricoesRepository,
    private readonly config: SorteConfigService,
    private readonly sga: SgaAuthService,
    private readonly beneficiosVeiculo: BeneficiosVeiculoService,
  ) {}

  /** Situação do associado, consultando o SGA só quando o cache venceu. */
  async situacao(
    userId: number,
    baseOrigin: string,
    config: SorteConfigView,
    opcoes: { forcar?: boolean; agora?: Date } = {},
  ): Promise<SituacaoInscricao> {
    const agora = opcoes.agora ?? new Date();
    const cache = await this.repository.buscar(userId);
    if (cache?.fonte === SorteInscricaoFonte.MANUAL) return deCache(cache);

    const validadeMs = config.inscricaoValidadeHoras * 3_600_000;
    if (
      !opcoes.forcar &&
      cache?.verificadoEm &&
      agora.getTime() - cache.verificadoEm.getTime() < validadeMs
    ) {
      return deCache(cache);
    }
    if (!opcoes.forcar && (this.esperaAte.get(userId) ?? 0) > Date.now()) {
      return cache ? deCache(cache) : indisponivel();
    }

    try {
      const r = await this.consultarComDedupe(userId, baseOrigin, config);
      await this.repository.salvarDoSga(userId, {
        baseOrigin,
        inscrito: r.inscrito,
        codigoVeiculo: r.codigoVeiculo,
        verificadoEm: agora,
      });
      this.esperaAte.delete(userId);
      return {
        inscrito: r.inscrito,
        motivo: r.inscrito ? null : 'NAO_INSCRITO',
        fonte: SorteInscricaoFonte.SGA,
        verificadoEm: agora,
      };
    } catch (erro) {
      this.esperaAte.set(
        userId,
        Date.now() + associadoSorteConfig().inscricaoEsperaAposFalhaMs,
      );
      this.logger.warn(
        `${baseTag(baseOrigin)} SGA indisponível ao verificar a inscrição do associado #${userId} (${cache ? 'usando o último valor' : 'sem cache'}): ${(erro as Error).message}`,
      );
      return cache ? deCache(cache) : indisponivel();
    }
  }

  private consultarComDedupe(
    userId: number,
    baseOrigin: string,
    config: SorteConfigView,
  ): Promise<ResultadoSga> {
    const existente = this.emVoo.get(userId);
    if (existente) return existente;
    const promessa = this.consultarSga(userId, baseOrigin, config).finally(() =>
      this.emVoo.delete(userId),
    );
    this.emVoo.set(userId, promessa);
    return promessa;
  }

  /**
   * Veículos via `associado/buscar/{cpf}` → só os que permitem acesso ao app
   * → produtos de cada um, parando no primeiro que tiver o produto.
   * Lança quando o SGA não respondeu (o chamador usa o cache).
   */
  private async consultarSga(
    userId: number,
    baseOrigin: string,
    config: SorteConfigView,
  ): Promise<ResultadoSga> {
    const usuario = await this.repository.buscarUsuario(userId);
    const cpf = String(usuario?.cpf ?? '').replace(/\D/g, '');
    if (!cpf) return { inscrito: false, codigoVeiculo: null };

    const resposta = await this.sga.executeRequestWithAuth<{
      veiculos?: unknown;
    }>(baseOrigin, {
      method: 'GET',
      url: `${SGA_BASE_URL}/associado/buscar/${cpf}`,
      validateStatus: () => true,
      compartilharEmVoo: true,
    });
    // 404/406: o SGA não conhece o CPF — resposta válida (não inscrito).
    if (resposta.status === 404 || resposta.status === 406) {
      return { inscrito: false, codigoVeiculo: null };
    }
    if (resposta.status >= 400) {
      throw new Error(`associado/buscar respondeu HTTP ${resposta.status}`);
    }

    const alvo = {
      codigo: config.produtoSgaCodigo,
      descricao: config.produtoSgaDescricao,
    };
    let falhas = 0;
    for (const veiculo of veiculosCandidatos(resposta.data?.veiculos)) {
      const codigo = String(veiculo.codigo_veiculo).trim();
      try {
        const beneficios = await this.beneficiosVeiculo.getBeneficiosVeiculo(
          baseOrigin,
          codigo,
        );
        const produtos = Array.isArray(beneficios?.produtos)
          ? beneficios.produtos
          : [];
        if (produtos.some((p) => produtoInscreve(p, alvo))) {
          return { inscrito: true, codigoVeiculo: codigo };
        }
      } catch {
        falhas++;
      }
    }
    if (falhas > 0) {
      throw new Error(
        `produtos de ${falhas} veículo(s) indisponíveis no SGA (CPF ${mascararCpf(cpf)})`,
      );
    }
    return { inscrito: false, codigoVeiculo: null };
  }

  // ------------------------------------------------------------------ painel

  async listar(query: ListarInscricoesQuery) {
    const busca = query.busca?.trim();
    const digitos = busca?.replace(/\D/g, '') ?? '';
    const where: Prisma.SorteInscricaoWhereInput = {
      ...(query.baseOrigin ? { baseOrigin: query.baseOrigin } : {}),
      ...(query.inscrito !== undefined
        ? { inscrito: query.inscrito === 'true' }
        : {}),
      ...(query.fonte ? { fonte: query.fonte } : {}),
      ...(busca
        ? {
            user: {
              OR: [
                { name: { contains: busca } },
                ...(digitos.length >= 3
                  ? [{ cpf: { contains: digitos } }]
                  : []),
              ],
            },
          }
        : {}),
    };
    const { data, total } = await this.repository.listar({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map((i) => ({
        associado: {
          id: i.user.id,
          nome: i.user.name,
          cpfMascarado: mascararCpf(i.user.cpf),
          ativo: i.user.isActive,
        },
        baseOrigin: i.baseOrigin,
        ...toInscricaoView(i),
      })),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  /** Consulta o SGA agora. Com marcação manual, devolve o SGA sem gravar. */
  async reverificar(userId: number) {
    const { baseOrigin, config } = await this.contexto(userId);
    const situacao = await this.situacao(userId, baseOrigin, config, {
      forcar: true,
    });
    const inscricao = await this.repository.buscar(userId);
    let sga: SituacaoInscricao | null = null;
    if (inscricao?.fonte === SorteInscricaoFonte.MANUAL) {
      try {
        const r = await this.consultarComDedupe(userId, baseOrigin, config);
        sga = {
          inscrito: r.inscrito,
          motivo: r.inscrito ? null : 'NAO_INSCRITO',
          fonte: SorteInscricaoFonte.SGA,
          verificadoEm: new Date(),
        };
      } catch {
        sga = indisponivel();
      }
    } else {
      sga = situacao;
    }
    return {
      userId,
      inscricao: inscricao ? toInscricaoView(inscricao) : null,
      situacao,
      sga,
    };
  }

  /** Marcação manual (prevalece sobre o SGA até ser desfeita). */
  async marcar(userId: number, dto: MarcarInscricaoDto, autor: SorteAutor) {
    const { baseOrigin } = await this.contexto(userId);
    const salvo = await this.repository.salvar(userId, {
      baseOrigin,
      inscrito: dto.inscrito,
      fonte: SorteInscricaoFonte.MANUAL,
      codigoVeiculo: null,
      verificadoEm: new Date(),
      autorId: autor.id,
      autorNome: autor.nome,
      motivo: dto.motivo?.trim() || null,
    });
    this.logger.log(
      `${baseTag(baseOrigin)} inscrição do associado #${userId} marcada à mão como ${dto.inscrito ? 'INSCRITO' : 'NÃO INSCRITO'} por ${autor.nome ?? `#${autor.id}`}`,
    );
    return { userId, inscricao: toInscricaoView(salvo) };
  }

  /** Desfaz a marcação manual e volta a valer o SGA (consulta na hora). */
  async desfazerMarcacao(userId: number, autor: SorteAutor) {
    const { baseOrigin, config } = await this.contexto(userId);
    await this.repository.remover(userId);
    this.esperaAte.delete(userId);
    const situacao = await this.situacao(userId, baseOrigin, config, {
      forcar: true,
    });
    const inscricao = await this.repository.buscar(userId);
    this.logger.log(
      `${baseTag(baseOrigin)} marcação manual da inscrição do associado #${userId} desfeita por ${autor.nome ?? `#${autor.id}`} (SGA: ${situacao.inscrito ? 'inscrito' : (situacao.motivo ?? 'não inscrito')})`,
    );
    return {
      userId,
      inscricao: inscricao ? toInscricaoView(inscricao) : null,
      situacao,
    };
  }

  private async contexto(userId: number) {
    const usuario = await this.repository.buscarUsuario(userId);
    if (!usuario) throw new NotFoundException('Associado não encontrado');
    const baseOrigin = usuario.baseOrigin ?? '';
    if (!isTenantBase(baseOrigin)) {
      throw erro422('BASE_INVALIDA', 'Associado sem base de origem válida');
    }
    return { baseOrigin, config: await this.config.obter(baseOrigin) };
  }
}

function deCache(cache: SorteInscricao): SituacaoInscricao {
  return {
    inscrito: cache.inscrito,
    motivo: cache.inscrito ? null : 'NAO_INSCRITO',
    fonte: cache.fonte,
    verificadoEm: cache.verificadoEm,
  };
}

function indisponivel(): SituacaoInscricao {
  return {
    inscrito: false,
    motivo: 'VERIFICACAO_INDISPONIVEL',
    fonte: null,
    verificadoEm: null,
  };
}
