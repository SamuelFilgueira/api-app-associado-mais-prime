import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Job, JobsOptions, Queue } from 'bullmq';
import { NomeDaFila } from 'src/queue/filas';
import { ComEnvelope, comEnvelope } from 'src/queue/job-envelope';
import { InfraError } from 'src/shared/erros/erros';

export interface OpcoesDeEnfileiramento {
  /** Base do job. Obrigatória para tudo que usa credencial de vendor. */
  base?: string | null;
  /**
   * Id determinístico, derivado da chave de negócio. O BullMQ ignora um
   * segundo `add` com o mesmo id enquanto o primeiro existir: é o que barra
   * a duplicata já na entrada (reentrega de webhook, duplo clique).
   * Não pode conter `:`.
   */
  jobId?: string;
  /** Atraso antes da primeira execução. */
  atrasoMs?: number;
  /** Demais opções do BullMQ; prevalecem sobre o padrão da fila. */
  opcoes?: JobsOptions;
}

/**
 * Porta de saída para as filas. Services e controllers enfileiram por aqui
 * em vez de injetar a `Queue` do BullMQ: o payload sai sempre com a base e
 * os metadados de rastreio, e os testes trocam esta classe por um fake.
 */
@Injectable()
export class ProdutorDeFilas {
  constructor(private readonly moduleRef: ModuleRef) {}

  async enfileirar<T extends object>(
    fila: NomeDaFila,
    nome: string,
    dados: T,
    opcoes: OpcoesDeEnfileiramento = {},
  ): Promise<Job<ComEnvelope<T>>> {
    const queue = this.moduleRef.get<Queue<ComEnvelope<T>>>(
      getQueueToken(fila),
      { strict: false },
    );

    try {
      // O tipo do `add` do BullMQ depende do nome do job; aqui o nome é livre.
      return (await queue.add(
        nome as never,
        comEnvelope(dados, opcoes.base) as never,
        {
          ...opcoes.opcoes,
          ...(opcoes.jobId ? { jobId: opcoes.jobId } : {}),
          ...(opcoes.atrasoMs ? { delay: opcoes.atrasoMs } : {}),
        },
      )) as Job<ComEnvelope<T>>;
    } catch (erro) {
      throw new InfraError(
        'fila',
        'Não foi possível registrar a solicitação agora. Tente novamente em instantes.',
        erro,
      );
    }
  }
}
