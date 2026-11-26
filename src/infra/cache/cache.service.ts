import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { metricas } from 'src/infra/observability/metricas';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';

export interface OpcoesDeLeitura<T> {
  /** Base dona do dado: vira o prefixo da chave. */
  base: string;
  /** Chave sem a base. Ex.: `sga:associado:52998224725`. */
  chave: string;
  /** Rótulo da métrica (conjunto fechado). Ex.: `sga_associado`. */
  recurso: string;
  /** Por quanto tempo o valor é servido sem consultar a origem. */
  ttlSeg: number;
  /**
   * Por quanto tempo, DEPOIS de vencido, o valor ainda pode ser servido se a
   * origem falhar. `0` (padrão) desliga: vencido é sempre recarregado.
   */
  antigoPorSeg?: number;
  /** Busca o valor na origem (vendor ou banco). */
  carregar: () => Promise<T>;
  /**
   * Só guarda o valor se for verdadeiro. Evita cachear resposta de erro que
   * veio com HTTP 200 — o padrão é guardar tudo que não for `undefined`.
   */
  guardarSe?: (valor: T) => boolean;
}

export interface ValorDoCache<T> {
  valor: T;
  /** `origem`: veio da origem agora; `cache`: fresco; `antigo`: vencido, origem falhou. */
  fonte: 'origem' | 'cache' | 'antigo';
  /** Quando o valor foi lido da origem. */
  atualizadoEm: Date;
}

/**
 * Teto do valor guardado (texto JSON). O Redis do cache é o mesmo das filas
 * e não descarta chave sozinho: um valor grande multiplicado por muitas
 * chaves ocuparia a memória de que o BullMQ precisa. Acima do teto o valor é
 * devolvido normalmente, só não é guardado.
 */
export const TAMANHO_MAXIMO_DO_VALOR = 512 * 1024;

interface Envelope<T> {
  v: T;
  /** Instante (ms) da leitura na origem. */
  t: number;
  /** Instante (ms) em que deixa de ser fresco (já com jitter). */
  f: number;
}

/**
 * Cache read-through no Redis, compartilhado entre os processos.
 *
 * Regras que valem para todo uso:
 *  - a chave sempre começa pela base (`{base}:{chave}`): nada de uma base
 *    lendo o que outra gravou;
 *  - todo valor tem expiração (o Redis é o mesmo das filas e roda em
 *    `noeviction` — chave sem prazo é memória que nunca volta);
 *  - leituras simultâneas da mesma chave fazem UMA ida à origem;
 *  - a expiração tem jitter de ±10%, para um lote de chaves gravado junto
 *    não vencer junto;
 *  - valor acima de `TAMANHO_MAXIMO_DO_VALOR` não é guardado;
 *  - Redis fora não é erro: a leitura vai direto à origem.
 *
 * Não cachear: saldo e estoque do Associado da Sorte, estado de boleto em
 * geração, resultado de comando de veículo.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly emVoo = new Map<string, Promise<ValorDoCache<unknown>>>();
  private ultimoAviso = 0;
  private readonly ultimoAvisoDeTamanho = new Map<string, number>();

  constructor(@Inject(REDIS_CLIENTE) private readonly redis: Redis) {}

  async obter<T>(opcoes: OpcoesDeLeitura<T>): Promise<ValorDoCache<T>> {
    const chave = this.chave(opcoes.base, opcoes.chave);
    const emVoo = this.emVoo.get(chave);
    if (emVoo) return emVoo as Promise<ValorDoCache<T>>;

    const promessa = this.ler(chave, opcoes).finally(() => {
      this.emVoo.delete(chave);
    });
    this.emVoo.set(chave, promessa as Promise<ValorDoCache<unknown>>);
    return promessa;
  }

  /** Apaga uma chave (invalidação por evento: pagamento, reativação...). */
  async invalidar(base: string, chave: string): Promise<void> {
    try {
      await this.redis.del(this.chave(base, chave));
    } catch (erro) {
      this.avisar(erro);
    }
  }

  private async ler<T>(
    chave: string,
    opcoes: OpcoesDeLeitura<T>,
  ): Promise<ValorDoCache<T>> {
    const guardado = await this.lerEnvelope<T>(chave);
    const agora = Date.now();

    if (guardado && agora < guardado.f) {
      metricas.cache.inc({ recurso: opcoes.recurso, resultado: 'acerto' });
      return {
        valor: guardado.v,
        fonte: 'cache',
        atualizadoEm: new Date(guardado.t),
      };
    }

    try {
      const valor = await opcoes.carregar();
      metricas.cache.inc({ recurso: opcoes.recurso, resultado: 'falta' });
      if (valor !== undefined && (opcoes.guardarSe?.(valor) ?? true)) {
        await this.gravar(chave, valor, opcoes);
      }
      return { valor, fonte: 'origem', atualizadoEm: new Date() };
    } catch (erro) {
      // Origem fora: serve o valor vencido, mas SÓ dentro da janela pedida
      // (`antigoPorSeg`). A chave pode sobreviver uns instantes além dela no
      // Redis, por arredondamento da expiração — isso não autoriza servir.
      const limiteDoAntigo = guardado
        ? guardado.f + Math.max(0, opcoes.antigoPorSeg ?? 0) * 1000
        : 0;
      if (guardado && Date.now() < limiteDoAntigo) {
        metricas.cache.inc({ recurso: opcoes.recurso, resultado: 'antigo' });
        this.logger.warn(
          `Origem de ${opcoes.recurso} falhou (${erro instanceof Error ? erro.message : String(erro)}); servindo valor de ${new Date(guardado.t).toISOString()}.`,
        );
        return {
          valor: guardado.v,
          fonte: 'antigo',
          atualizadoEm: new Date(guardado.t),
        };
      }
      metricas.cache.inc({ recurso: opcoes.recurso, resultado: 'erro' });
      throw erro;
    }
  }

  private async lerEnvelope<T>(chave: string): Promise<Envelope<T> | null> {
    try {
      const bruto = await this.redis.get(chave);
      if (!bruto) return null;
      const envelope = JSON.parse(bruto) as Envelope<T>;
      return typeof envelope?.t === 'number' && typeof envelope?.f === 'number'
        ? envelope
        : null;
    } catch (erro) {
      this.avisar(erro);
      return null;
    }
  }

  private async gravar<T>(
    chave: string,
    valor: T,
    opcoes: OpcoesDeLeitura<T>,
  ): Promise<void> {
    const agora = Date.now();
    const jitter = 0.9 + Math.random() * 0.2;
    const frescoMs = Math.round(opcoes.ttlSeg * 1000 * jitter);
    const totalSeg = Math.ceil(
      frescoMs / 1000 + Math.max(0, opcoes.antigoPorSeg ?? 0),
    );
    const envelope: Envelope<T> = { v: valor, t: agora, f: agora + frescoMs };
    const texto = JSON.stringify(envelope);
    if (texto.length > TAMANHO_MAXIMO_DO_VALOR) {
      this.avisarValorGrande(opcoes.recurso, texto.length);
      return;
    }

    try {
      await this.redis.set(chave, texto, 'EX', Math.max(1, totalSeg));
    } catch (erro) {
      this.avisar(erro);
    }
  }

  private chave(base: string, chave: string): string {
    return `${base}:${chave}`;
  }

  private avisarValorGrande(recurso: string, tamanho: number): void {
    const agora = Date.now();
    const ultimo = this.ultimoAvisoDeTamanho.get(recurso) ?? 0;
    if (agora - ultimo < 10 * 60_000) return;
    this.ultimoAvisoDeTamanho.set(recurso, agora);
    this.logger.warn(
      `Valor de "${recurso}" com ${Math.round(tamanho / 1024)} KB não entra no cache (teto de ${TAMANHO_MAXIMO_DO_VALOR / 1024} KB); a leitura segue indo à origem.`,
    );
  }

  private avisar(erro: unknown): void {
    const agora = Date.now();
    if (agora - this.ultimoAviso < 60_000) return;
    this.ultimoAviso = agora;
    this.logger.warn(
      `Cache sem Redis (${erro instanceof Error ? erro.message : String(erro)}); leituras vão direto à origem.`,
    );
  }
}
