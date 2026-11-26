import type Redis from 'ioredis';

/**
 * Redis mínimo em memória para testes de UNIDADE do que só usa `GET`, `SET`
 * com expiração, `DEL` e `MGET` (cache e sessões). Não executa Lua: o que
 * depende de script (limitador, trava) é coberto pelos testes de integração,
 * com Redis de verdade.
 */
export class RedisEmMemoria {
  private readonly dados = new Map<
    string,
    { valor: string; expiraEm: number }
  >();
  /** Quando `true`, todo comando rejeita — simula o Redis fora do ar. */
  fora = false;

  get(chave: string): Promise<string | null> {
    return this.executar(() => this.ler(chave));
  }

  mget(...chaves: string[]): Promise<Array<string | null>> {
    return this.executar(() => chaves.map((chave) => this.ler(chave)));
  }

  set(chave: string, valor: string, ...args: unknown[]): Promise<'OK'> {
    return this.executar(() => {
      const posicao = args.findIndex((a) => a === 'EX' || a === 'PX');
      const quantidade = posicao >= 0 ? Number(args[posicao + 1]) : Infinity;
      const ms = args[posicao] === 'PX' ? quantidade : quantidade * 1000;
      this.dados.set(chave, { valor, expiraEm: Date.now() + ms });
      return 'OK' as const;
    });
  }

  del(...chaves: string[]): Promise<number> {
    return this.executar(
      () => chaves.filter((chave) => this.dados.delete(chave)).length,
    );
  }

  chaves(): string[] {
    return [...this.dados.keys()];
  }

  /** Para injetar onde o tipo esperado é o cliente do ioredis. */
  comoRedis(): Redis {
    return this as unknown as Redis;
  }

  private ler(chave: string): string | null {
    const item = this.dados.get(chave);
    if (!item) return null;
    if (item.expiraEm <= Date.now()) {
      this.dados.delete(chave);
      return null;
    }
    return item.valor;
  }

  private executar<T>(fn: () => T): Promise<T> {
    return this.fora
      ? Promise.reject(new Error('Connection is closed.'))
      : Promise.resolve(fn());
  }
}
