import { Injectable } from '@nestjs/common';
import {
  AlloyalCategoriaResumo,
  CHAVE_CATEGORIAS_DO_PAINEL,
  PRAZO_CATEGORIAS_DO_PAINEL_SEG,
  resumirCategorias,
} from 'src/beneficios/domain/alloyal-catalogo-cache';
import { CacheService } from 'src/infra/cache/cache.service';

export type { AlloyalCategoriaResumo };

const RECURSO = 'alloyal_categorias_painel';

/** Quantas vezes regravar se a gravação cair numa leitura em andamento. */
const TENTATIVAS_DE_GRAVACAO = 3;

/**
 * Categorias da Alloyal por base, para o painel (formulário de parceiros
 * diretos, §5.0).
 *
 * A Alloyal só devolve categorias com a sessão de um usuário final
 * (uid/client/access-token), que o painel não tem. Por isso quem alimenta
 * este resumo é o app: sempre que `GET /alloyal/categories` consulta a
 * Alloyal de fato (cache do catálogo vencido), o `AlloyalCatalogoService`
 * guarda aqui o id e o título de cada categoria da base, por 7 dias.
 *
 * Chave própria (`<base>:alloyal:catalogo:categorias_painel`), separada da
 * que o app lê: uma leitura do painel nunca responde no lugar da Alloyal
 * para o app.
 *
 * Redis fora nunca propaga (é o `CacheService` que absorve): o app segue
 * normalmente e o painel recebe lista vazia para a base.
 */
@Injectable()
export class AlloyalCategoriesCacheService {
  constructor(private readonly cache: CacheService) {}

  /** Guarda o resumo das categorias recém-lidas da Alloyal. */
  async armazenar(
    baseOrigin: string | undefined,
    categorias: unknown,
  ): Promise<void> {
    if (!baseOrigin) return;
    const resumo = resumirCategorias(categorias);
    if (resumo.length === 0) return;

    for (let i = 0; i < TENTATIVAS_DE_GRAVACAO; i++) {
      // O read-through só grava quando não há valor: apaga e "lê" tendo o
      // resumo novo como origem.
      await this.cache.invalidar(baseOrigin, CHAVE_CATEGORIAS_DO_PAINEL);
      const gravado = await this.cache.obter<AlloyalCategoriaResumo[]>({
        base: baseOrigin,
        chave: CHAVE_CATEGORIAS_DO_PAINEL,
        recurso: RECURSO,
        ttlSeg: PRAZO_CATEGORIAS_DO_PAINEL_SEG,
        carregar: () => Promise.resolve(resumo),
      });
      // Leituras simultâneas da mesma chave compartilham UMA ida à origem:
      // se havia uma leitura do painel em andamento, o que voltou foi a
      // lista vazia dela, e nada foi gravado. Tenta de novo.
      if (gravado.valor === resumo || gravado.fonte !== 'origem') return;
    }
  }

  /** Categorias guardadas da base; `[]` se o app ainda não as carregou. */
  async obter(baseOrigin: string): Promise<AlloyalCategoriaResumo[]> {
    const { valor } = await this.cache.obter<AlloyalCategoriaResumo[]>({
      base: baseOrigin,
      chave: CHAVE_CATEGORIAS_DO_PAINEL,
      recurso: RECURSO,
      ttlSeg: PRAZO_CATEGORIAS_DO_PAINEL_SEG,
      // Não há origem para o painel: sem valor guardado, lista vazia —
      // que não é gravada.
      carregar: () => Promise.resolve([]),
      guardarSe: () => false,
    });
    return Array.isArray(valor) ? valor : [];
  }

  /** Uma entrada por base; base sem cache devolve `[]`. */
  async obterPorBase(
    bases: string[],
  ): Promise<Record<string, AlloyalCategoriaResumo[]>> {
    const resultado: Record<string, AlloyalCategoriaResumo[]> = {};
    await Promise.all(
      bases.map(async (base) => {
        resultado[base] = await this.obter(base);
      }),
    );
    return resultado;
  }
}
