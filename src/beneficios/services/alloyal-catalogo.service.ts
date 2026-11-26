import { Injectable } from '@nestjs/common';
import {
  mapearFilial,
  mapearOrganizacao,
  mapearOrganizacaoDaCategoria,
  mapearOrganizacaoSemDistancia,
  mapearPromocao,
} from 'src/beneficios/domain/alloyal-catalogo';
import {
  CHAVE_CATEGORIAS,
  CHAVE_DESTAQUES_ONLINE,
  chaveDeOrganizacoes,
  listaComItens,
} from 'src/beneficios/domain/alloyal-catalogo-cache';
import {
  Coordenadas,
  FiltrosDeOrganizacoes,
  FiltrosDePromocoes,
  idNumerico,
  paramsDeCoordenadas,
  paramsDeOrganizacoes,
  paramsDeOrganizacoesDaCategoria,
  paramsDePromocoes,
} from 'src/beneficios/domain/alloyal-consultas';
import { AlloyalBranchDto } from 'src/beneficios/dto/alloyal-branch.dto';
import { AlloyalCategoryDto } from 'src/beneficios/dto/alloyal-category.dto';
import { AlloyalOrganizationHighlightOnlineDto } from 'src/beneficios/dto/alloyal-organization-highlight-online.dto';
import { AlloyalOrganizationHighlightDto } from 'src/beneficios/dto/alloyal-organization-highlight.dto';
import { AlloyalOrganizationListDto } from 'src/beneficios/dto/alloyal-organization-list.dto';
import { AlloyalOrganizationNearestDto } from 'src/beneficios/dto/alloyal-organization-nearest.dto';
import { AlloyalOrganizationCategoryDto } from 'src/beneficios/dto/alloyal-organization.dto';
import { AlloyalPromotionDto } from 'src/beneficios/dto/alloyal-promotion.dto';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { BaseOrigin } from 'src/config/tenant.config';
import { CacheService } from 'src/infra/cache/cache.service';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';
import { prazosDoCacheAlloyal } from 'src/config/integracoes.config';

/**
 * Catálogo do clube de vantagens: categorias, organizações, filiais e
 * promoções.
 *
 * Três leituras passam pelo cache (read-through, por base): categorias,
 * destaques online e a listagem de organizações sem coordenada nem busca —
 * as que são iguais para todos os associados da base. A regra completa do
 * que entra e do que fica de fora está em `domain/alloyal-catalogo-cache`.
 *
 * Com valor em cache a Alloyal não é consultada — logo a sessão do usuário
 * não é conferida por ela nessa leitura. Os cabeçalhos de sessão continuam
 * obrigatórios (a rota os exige antes de chegar aqui), e o catálogo não é
 * dado do usuário.
 */
@Injectable()
export class AlloyalCatalogoService {
  constructor(
    private readonly alloyal: AlloyalGateway,
    private readonly cache: CacheService,
    private readonly categoriasDoPainel: AlloyalCategoriesCacheService,
  ) {}

  /** Categorias da base, como a Alloyal devolve. */
  categorias(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<AlloyalCategoryDto[]> {
    return this.comCache(
      base,
      CHAVE_CATEGORIAS,
      'alloyal_categorias',
      prazosDoCacheAlloyal().categoriasSeg,
      async () => {
        const categorias = await this.alloyal.listarCategorias(base, sessao);
        // O painel não tem sessão na Alloyal: é daqui que ele recebe as
        // categorias da base (§5.0 dos parceiros diretos).
        await this.categoriasDoPainel.armazenar(base, categorias);
        return categorias as AlloyalCategoryDto[];
      },
    );
  }

  /** Organizações de uma categoria. Sem cache: traz `favorited` do usuário. */
  async organizacoesDaCategoria(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    categoriaId: string,
    filtros: Coordenadas & { page?: string },
  ): Promise<AlloyalOrganizationCategoryDto[]> {
    const organizacoes = await this.alloyal.listarOrganizacoesDaCategoria(
      base,
      sessao,
      categoriaId,
      paramsDeOrganizacoesDaCategoria(filtros),
    );
    return organizacoes.map((org) => mapearOrganizacaoDaCategoria(org));
  }

  /** Listagem geral, com filtros. Só a consulta sem coordenada nem busca usa cache. */
  organizacoes(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    filtros: FiltrosDeOrganizacoes,
  ): Promise<AlloyalOrganizationListDto[]> {
    const params = paramsDeOrganizacoes(filtros);
    const carregar = async () => {
      const organizacoes = await this.alloyal.listarOrganizacoes(
        base,
        sessao,
        params,
      );
      return organizacoes.map((org) => mapearOrganizacao(org));
    };

    const chave = chaveDeOrganizacoes(params);
    if (!chave) return carregar();
    return this.comCache(
      base,
      chave,
      'alloyal_organizacoes',
      prazosDoCacheAlloyal().organizacoesSeg,
      carregar,
    );
  }

  /** Organizações físicas mais próximas do ponto informado. */
  async organizacoesProximas(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    coordenadas: Coordenadas,
  ): Promise<AlloyalOrganizationNearestDto[]> {
    const organizacoes = await this.alloyal.listarOrganizacoesProximas(
      base,
      sessao,
      paramsDeCoordenadas(coordenadas),
    );
    return organizacoes.map((org) => mapearOrganizacao(org));
  }

  /** Destaques próximos do ponto informado. */
  async destaquesProximos(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    coordenadas: Coordenadas,
  ): Promise<AlloyalOrganizationHighlightDto[]> {
    const organizacoes = await this.alloyal.listarDestaquesProximos(
      base,
      sessao,
      paramsDeCoordenadas(coordenadas),
    );
    return organizacoes.map((org) => mapearOrganizacao(org));
  }

  /** Destaques online (sem distância). */
  destaquesOnline(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<AlloyalOrganizationHighlightOnlineDto[]> {
    return this.comCache(
      base,
      CHAVE_DESTAQUES_ONLINE,
      'alloyal_destaques_online',
      prazosDoCacheAlloyal().destaquesOnlineSeg,
      async () => {
        const organizacoes = await this.alloyal.listarDestaquesOnline(
          base,
          sessao,
        );
        return organizacoes.map((org) => mapearOrganizacaoSemDistancia(org));
      },
    );
  }

  /** Filiais físicas de uma organização, com a distância até o ponto. */
  async filiais(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: string,
    coordenadas: Coordenadas,
  ): Promise<AlloyalBranchDto[]> {
    const filiais = await this.alloyal.listarFiliais(
      base,
      sessao,
      idNumerico(organizacaoId),
      paramsDeCoordenadas(coordenadas),
    );
    return filiais.map((filial) => mapearFilial(filial));
  }

  async promocoes(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    filtros: FiltrosDePromocoes,
  ): Promise<AlloyalPromotionDto[]> {
    const promocoes = await this.alloyal.listarPromocoes(
      base,
      sessao,
      paramsDePromocoes(filtros),
    );
    return promocoes.map((promocao) => mapearPromocao(promocao));
  }

  /**
   * Leitura com cache por base. Só lista com itens é guardada: erro propaga
   * sem gravar nada, e lista vazia (ou corpo fora do formato) é devolvida
   * mas não fica no cache. Redis fora = leitura direta na Alloyal.
   */
  private async comCache<T>(
    base: BaseOrigin,
    chave: string,
    recurso: string,
    ttlSeg: number,
    carregar: () => Promise<T>,
  ): Promise<T> {
    if (ttlSeg <= 0) return carregar();
    const { valor } = await this.cache.obter<T>({
      base,
      chave,
      recurso,
      ttlSeg,
      carregar,
      guardarSe: listaComItens,
    });
    return valor;
  }
}
