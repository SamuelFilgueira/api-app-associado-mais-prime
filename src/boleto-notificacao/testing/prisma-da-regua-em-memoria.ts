/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- dublê de teste: registros são objetos soltos e os métodos imitam a API assíncrona do Prisma */
import { Prisma } from '@prisma/client';

type Linha = Record<string, any>;

function igual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (a === undefined || a === null) return b === undefined || b === null;
  return a === b;
}

/** Subconjunto do `where` do Prisma usado pela régua. */
function casa(linha: Linha, where: Linha = {}): boolean {
  return Object.entries(where).every(([campo, condicao]) => {
    if (condicao === undefined) return true;
    const valor = linha[campo];
    if (
      condicao !== null &&
      typeof condicao === 'object' &&
      !(condicao instanceof Date)
    ) {
      if ('in' in condicao) {
        return (condicao.in as unknown[]).some((v) => igual(valor, v));
      }
      if ('not' in condicao) return !igual(valor, condicao.not);
      if ('startsWith' in condicao) {
        return (
          typeof valor === 'string' &&
          valor.startsWith(condicao.startsWith as string)
        );
      }
      throw new Error(
        `Dublê do Prisma: filtro não suportado em "${campo}": ${JSON.stringify(condicao)}`,
      );
    }
    return igual(valor, condicao);
  });
}

function projetar(linha: Linha, select?: Record<string, boolean>): Linha {
  if (!select) return { ...linha };
  return Object.fromEntries(
    Object.keys(select)
      .filter((campo) => select[campo])
      .map((campo) => [campo, linha[campo]]),
  );
}

/**
 * Prisma em memória com as tabelas que a régua de boletos toca
 * (`BoletoNotificacaoExecucao`, `BoletoNotificacaoLog`, `user`,
 * `notification`). Guarda estado de verdade: a unique de idempotência
 * rejeita com `P2002` e `updateMany` devolve o número de linhas afetadas —
 * os specs conferem o ESTADO final, não a chamada que o produziu.
 *
 * Não é usado em produção (pasta `testing/` fica fora do build).
 */
export class PrismaDaReguaEmMemoria {
  readonly execucoes: Linha[] = [];
  readonly logs: Linha[] = [];
  readonly usuarios: Linha[] = [];
  readonly notificacoes: Linha[] = [];
  private sequencia = 0;

  /** Relógio do dublê (`criadoEm`/`atualizadoEm`); os specs podem trocar. */
  agora: () => Date = () => new Date();

  readonly boletoNotificacaoExecucao = {
    create: async ({ data, select }: any) => {
      const linha = {
        id: ++this.sequencia,
        status: 'EM_ANDAMENTO',
        origem: 'AGENDADA',
        dryRun: false,
        totalEnfileirados: 0,
        erro: null,
        iniciadoEm: this.agora(),
        finalizadoEm: null,
        ...data,
      };
      this.execucoes.push(linha);
      return projetar(linha, select);
    },
    update: async ({ where, data }: any) => {
      const linha = this.execucoes.find((e) => casa(e, where));
      if (!linha) throw new Error(`Execução não encontrada: ${where?.id}`);
      Object.assign(linha, data);
      return { ...linha };
    },
    updateMany: async ({ where, data }: any) => {
      const alvo = this.execucoes.filter((e) => casa(e, where));
      alvo.forEach((linha) => Object.assign(linha, data));
      return { count: alvo.length };
    },
    findUnique: async ({ where, select }: any) => {
      const linha = this.execucoes.find((e) => casa(e, where));
      return linha ? projetar(linha, select) : null;
    },
    groupBy: async ({ where }: any) => {
      const porBase = new Map<string, Date | null>();
      for (const linha of this.execucoes.filter((e) => casa(e, where))) {
        const atual = porBase.get(linha.tenant) ?? null;
        const fim = (linha.finalizadoEm as Date | null) ?? null;
        porBase.set(linha.tenant, fim && (!atual || fim > atual) ? fim : atual);
      }
      return Array.from(porBase.entries()).map(([tenant, finalizadoEm]) => ({
        tenant,
        _max: { finalizadoEm },
      }));
    },
  };

  readonly boletoNotificacaoLog = {
    create: async ({ data, select }: any) => {
      const duplicado = this.logs.some(
        (l) =>
          l.tenant === data.tenant &&
          l.codigoAssociado === data.codigoAssociado &&
          l.tipoMensagem === data.tipoMensagem &&
          igual(l.dataVencimentoOriginal, data.dataVencimentoOriginal),
      );
      if (duplicado) {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'teste',
        });
      }
      const agora = this.agora();
      const linha = {
        id: ++this.sequencia,
        statusEnvio: 'ENFILEIRADO',
        expoTicketId: null,
        expoErro: null,
        criadoEm: agora,
        atualizadoEm: agora,
        ...data,
      };
      this.logs.push(linha);
      return projetar(linha, select);
    },
    findMany: async ({ where, select }: any = {}) =>
      this.logs.filter((l) => casa(l, where)).map((l) => projetar(l, select)),
    update: async ({ where, data }: any) => {
      const linha = this.logs.find((l) => casa(l, where));
      if (!linha) throw new Error(`Log não encontrado: ${where?.id}`);
      Object.assign(linha, { atualizadoEm: this.agora() }, data);
      return { ...linha };
    },
    updateMany: async ({ where, data }: any) => {
      const alvo = this.logs.filter((l) => casa(l, where));
      alvo.forEach((linha) =>
        Object.assign(linha, { atualizadoEm: this.agora() }, data),
      );
      return { count: alvo.length };
    },
    count: async ({ where }: any = {}) =>
      this.logs.filter((l) => casa(l, where)).length,
  };

  readonly user = {
    findMany: async ({ where, select }: any = {}) =>
      this.usuarios
        .filter((u) => casa(u, where))
        .map((u) => projetar(u, select)),
    updateMany: async ({ where, data }: any) => {
      const alvo = this.usuarios.filter((u) => casa(u, where));
      alvo.forEach((linha) => Object.assign(linha, data));
      return { count: alvo.length };
    },
  };

  readonly notification = {
    createMany: async ({ data }: any) => {
      this.notificacoes.push(...(data as Linha[]));
      return { count: (data as Linha[]).length };
    },
  };

  /** Cadastra um usuário do app com token de push válido para o CPF. */
  comUsuario(
    cpf: string,
    extras: Linha = {},
  ): { id: number; expoPushToken: string } {
    const expoPushToken = `ExponentPushToken[${cpf.padStart(22, 'x').slice(0, 22)}]`;
    const usuario = {
      id: this.usuarios.length + 1,
      cpf,
      isActive: true,
      baseOrigin: 'MAIS_PRIME',
      expoPushToken,
      ...extras,
    };
    this.usuarios.push(usuario);
    return usuario;
  }
}
