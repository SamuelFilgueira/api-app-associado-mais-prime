/**
 * Semáforo em memória: no máximo `maximo` execuções simultâneas; as demais
 * esperam a vez, em ordem de chegada.
 *
 * Vale para o processo inteiro (não por requisição) — é isso que impede que
 * N requisições, cada uma com o seu "pool de workers", somem mais
 * concorrência do que o recurso compartilhado aguenta.
 */
export class Semaforo {
  private emUso = 0;
  private readonly espera: Array<() => void> = [];

  constructor(private readonly maximo: number) {
    if (!Number.isInteger(maximo) || maximo < 1) {
      throw new Error(`Semáforo precisa de um máximo inteiro >= 1 (${maximo})`);
    }
  }

  async executar<T>(fn: () => Promise<T>): Promise<T> {
    await this.adquirir();
    try {
      return await fn();
    } finally {
      this.liberar();
    }
  }

  estado(): { emUso: number; naEspera: number } {
    return { emUso: this.emUso, naEspera: this.espera.length };
  }

  private adquirir(): Promise<void> {
    if (this.emUso < this.maximo) {
      this.emUso += 1;
      return Promise.resolve();
    }
    return new Promise((resolver) => {
      this.espera.push(() => {
        this.emUso += 1;
        resolver();
      });
    });
  }

  private liberar(): void {
    this.emUso -= 1;
    this.espera.shift()?.();
  }
}
