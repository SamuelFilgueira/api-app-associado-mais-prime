import { TravaService } from 'src/infra/redis/trava.service';
import {
  OpcoesDeEnfileiramento,
  ProdutorDeFilas,
} from 'src/queue/produtor-de-filas.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- dublê de teste: o payload do job é livre, e os specs leem os campos direto */
export interface JobFalso<T = any> {
  id: string;
  fila: string;
  nome: string;
  dados: T;
  opcoes: OpcoesDeEnfileiramento;
}

/**
 * `ProdutorDeFilas` em memória. Reproduz o que importa do BullMQ para os
 * testes de unidade: um segundo `add` com o mesmo `jobId`, na mesma fila,
 * não cria outro job.
 */
export class ProdutorFalso {
  readonly jobs: JobFalso[] = [];
  /** Quando preenchido, todo `enfileirar` rejeita (Redis fora). */
  erro: Error | null = null;
  private sequencia = 0;

  enfileirar<T extends object>(
    fila: string,
    nome: string,
    dados: T,
    opcoes: OpcoesDeEnfileiramento = {},
  ): Promise<JobFalso<T>> {
    if (this.erro) return Promise.reject(this.erro);

    const id = opcoes.jobId ?? `auto-${++this.sequencia}`;
    const existente = this.jobs.find((j) => j.fila === fila && j.id === id);
    if (existente) return Promise.resolve(existente as JobFalso<T>);

    const job: JobFalso<T> = {
      id,
      fila,
      nome,
      dados: JSON.parse(JSON.stringify(dados)) as T,
      opcoes,
    };
    this.jobs.push(job);
    return Promise.resolve(job);
  }

  /** Jobs de uma fila (e, se informado, de um nome). */
  da<T = any>(fila: string, nome?: string): JobFalso<T>[] {
    return this.jobs.filter(
      (j) => j.fila === fila && (nome === undefined || j.nome === nome),
    ) as JobFalso<T>[];
  }

  comoProdutor(): ProdutorDeFilas {
    return this as unknown as ProdutorDeFilas;
  }
}

/**
 * `TravaService` em memória, com exclusão de verdade dentro do processo:
 * enquanto uma execução segura a chave, a outra recebe `executou: false`.
 */
export class TravaFalsa {
  private readonly presas = new Set<string>();
  /** Chaves que alguém tentou pegar enquanto estavam presas. */
  readonly negadas: string[] = [];

  async tentar<T>(
    chave: string,
    _ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ executou: true; valor: T } | { executou: false }> {
    if (this.presas.has(chave)) {
      this.negadas.push(chave);
      return { executou: false };
    }
    this.presas.add(chave);
    try {
      return { executou: true, valor: await fn() };
    } finally {
      this.presas.delete(chave);
    }
  }

  comoTrava(): TravaService {
    return this as unknown as TravaService;
  }
}
