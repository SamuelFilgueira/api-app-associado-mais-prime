import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ALLOYAL_REDIS } from 'src/beneficios/providers/alloyal-redis.provider';
import { baseTag } from 'src/shared/log.util';

export interface AlloyalCategoriaResumo {
  id: number;
  title: string;
}

/**
 * Cache das categorias da Alloyal por base.
 *
 * A API da Alloyal só devolve categorias com sessão de um usuário final
 * (uid/client/access-token), que o painel administrativo não possui. Por
 * isso o cache é alimentado pelo próprio app: toda vez que um associado
 * carrega `GET /alloyal/categories`, a lista da base do JWT é guardada aqui
 * e fica disponível para o formulário de parceiros diretos (§5.0).
 *
 * Falha de Redis nunca propaga: o app segue normalmente e o painel recebe
 * lista vazia para a base.
 */
@Injectable()
export class AlloyalCategoriesCacheService {
  private readonly logger = new Logger(AlloyalCategoriesCacheService.name);
  private static readonly TTL_SEGUNDOS = 7 * 24 * 60 * 60;

  constructor(@Inject(ALLOYAL_REDIS) private readonly redis: Redis) {}

  private chave(baseOrigin: string): string {
    return `alloyal:categorias:${baseOrigin}`;
  }

  async armazenar(
    baseOrigin: string | undefined,
    categorias: unknown,
  ): Promise<void> {
    if (!baseOrigin || !Array.isArray(categorias)) return;

    const resumo: AlloyalCategoriaResumo[] = categorias
      .filter((c) => c && typeof c === 'object' && Number.isInteger(c.id))
      .map((c) => ({ id: Number(c.id), title: String(c.title ?? '') }));

    if (resumo.length === 0) return;

    try {
      await this.redis.set(
        this.chave(baseOrigin),
        JSON.stringify(resumo),
        'EX',
        AlloyalCategoriesCacheService.TTL_SEGUNDOS,
      );
    } catch (error) {
      this.logger.warn(
        `${baseTag(baseOrigin)} falha ao gravar cache de categorias Alloyal: ${error.message}`,
      );
    }
  }

  async obter(baseOrigin: string): Promise<AlloyalCategoriaResumo[]> {
    try {
      const raw = await this.redis.get(this.chave(baseOrigin));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AlloyalCategoriaResumo[]) : [];
    } catch (error) {
      this.logger.warn(
        `${baseTag(baseOrigin)} falha ao ler cache de categorias Alloyal: ${error.message}`,
      );
      return [];
    }
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
