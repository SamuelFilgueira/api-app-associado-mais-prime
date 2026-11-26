/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- dublê de teste: os registros são objetos soltos, conferidos pelos specs */
import { PrismaService } from 'src/database/prisma.service';

export interface UsuarioFake {
  id: number;
  isActive: boolean;
  baseOrigin: string | null;
  ancoraAtiva: boolean;
  notificacaoIgnicao: boolean;
  expoPushToken: string | null;
}

export interface VeiculoFake {
  id: number;
  userId: number;
  chassi: string;
  plate: string | null;
  isActive: boolean;
  cortarRastreamento: boolean;
  provedorRastreamento: string | null;
  provedorVerificadoEm: Date | null;
  provedorFalhas: number;
  ancoraAtiva: boolean | null;
  notificacaoIgnicao: boolean | null;
}

export interface EventoFake {
  id: number;
  chassi: string;
  evento: string | null;
  tipoevento: number | null;
  provider: string;
  payload: unknown;
  receivedAt: Date;
  processed: boolean;
  eventoHash: string | null;
}

export interface ComandoFake {
  id: number;
  userId: number;
  userVehicleId: number | null;
  chassi: string;
  baseOrigin: string | null;
  comando: string;
  valor: boolean;
  resultado: string;
  erro: string | null;
  criadoEm: Date;
}

/** Erro com o mesmo `code` que o Prisma devolve na violação de índice único. */
export function erroDeUnicidade(): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

function ehCondicao(valor: unknown): valor is Record<string, unknown> {
  return (
    valor !== null && typeof valor === 'object' && !(valor instanceof Date)
  );
}

function iguais(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

function compara(valor: unknown, cond: Record<string, unknown>): boolean {
  if ('equals' in cond && !iguais(valor, cond.equals)) return false;
  if ('not' in cond && iguais(valor, cond.not)) return false;
  if ('in' in cond && !(cond.in as unknown[]).some((v) => iguais(valor, v))) {
    return false;
  }
  const numero = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  if ('gt' in cond && !(numero(valor) > numero(cond.gt))) return false;
  if ('gte' in cond && !(numero(valor) >= numero(cond.gte))) return false;
  if ('lt' in cond && !(numero(valor) < numero(cond.lt))) return false;
  if ('lte' in cond && !(numero(valor) <= numero(cond.lte))) return false;
  return true;
}

/**
 * Banco em memória só com o que o rastreamento usa (`user`, `UserVehicle`,
 * `VehicleWebhookEvent`, `VeiculoComandoLog`), no formato do Prisma Client.
 *
 * Serve aos specs de unidade: as asserções olham o ESTADO que ficou gravado,
 * não a forma da chamada — por isso sobrevivem à troca de `update` por
 * `updateMany`, à entrada de transação etc. Índice único de `eventoHash`
 * devolve `P2002`, como o banco. Trava, isolamento e concorrência de verdade
 * ficam nos testes de integração.
 */
export class BancoRastreamentoEmMemoria {
  usuarios: UsuarioFake[] = [];
  veiculos: VeiculoFake[] = [];
  eventos: EventoFake[] = [];
  comandos: ComandoFake[] = [];
  /** Erro devolvido pela próxima operação da tabela (uma vez). */
  private readonly falhas = new Map<string, Error>();
  private proximoId = 1;

  // ------------------------------------------------------------- preparo

  comUsuario(usuario: Partial<UsuarioFake> = {}): UsuarioFake {
    const novo: UsuarioFake = {
      id: this.proximoId++,
      isActive: true,
      baseOrigin: 'MAIS_PRIME',
      ancoraAtiva: false,
      notificacaoIgnicao: false,
      expoPushToken: null,
      ...usuario,
    };
    this.usuarios.push(novo);
    return novo;
  }

  comVeiculo(
    veiculo: Partial<VeiculoFake> & { userId: number; chassi: string },
  ): VeiculoFake {
    const novo: VeiculoFake = {
      id: this.proximoId++,
      plate: null,
      isActive: true,
      cortarRastreamento: false,
      provedorRastreamento: null,
      provedorVerificadoEm: null,
      provedorFalhas: 0,
      ancoraAtiva: null,
      notificacaoIgnicao: null,
      ...veiculo,
    };
    this.veiculos.push(novo);
    return novo;
  }

  /** A próxima operação em `tabela` (ex.: `vehicleWebhookEvent`) falha. */
  falharNaProxima(tabela: string, erro: Error): void {
    this.falhas.set(tabela, erro);
  }

  veiculo(chassi: string, userId?: number): VeiculoFake | undefined {
    return this.veiculos.find(
      (v) =>
        v.chassi === chassi && (userId === undefined || v.userId === userId),
    );
  }

  usuario(id: number): UsuarioFake | undefined {
    return this.usuarios.find((u) => u.id === id);
  }

  // ------------------------------------------------------------ "prisma"

  get prisma(): PrismaService {
    const cliente: any = {
      userVehicle: this.tabela('userVehicle', () => this.veiculos, {
        relacao: (v: VeiculoFake) => ({
          user: this.usuarios.find((u) => u.id === v.userId),
        }),
      }),
      user: this.tabela('user', () => this.usuarios),
      vehicleWebhookEvent: this.tabela(
        'vehicleWebhookEvent',
        () => this.eventos,
        {
          padrao: () => ({
            provider: 'M7',
            receivedAt: new Date(),
            processed: false,
            eventoHash: null,
          }),
          unico: 'eventoHash',
        },
      ),
      veiculoComandoLog: this.tabela('veiculoComandoLog', () => this.comandos, {
        padrao: () => ({
          userVehicleId: null,
          baseOrigin: null,
          erro: null,
          criadoEm: new Date(),
        }),
      }),
    };
    // `SELECT ... FOR UPDATE` do repositório: em memória não há o que travar.
    cliente.$queryRaw = () => Promise.resolve([]);
    cliente.$transaction = (entrada: unknown) =>
      typeof entrada === 'function'
        ? (entrada as (tx: unknown) => Promise<unknown>)(cliente)
        : Promise.all(entrada as Promise<unknown>[]);
    return cliente as PrismaService;
  }

  private tabela<T extends { id: number }>(
    nome: string,
    linhas: () => T[],
    opcoes: {
      relacao?: (linha: T) => Record<string, unknown>;
      padrao?: () => Record<string, unknown>;
      unico?: string;
    } = {},
  ) {
    const comRelacao = (linha: T) => ({
      ...linha,
      ...(opcoes.relacao?.(linha) ?? {}),
    });
    const filtrar = (where: any): T[] =>
      linhas().filter((linha) => this.corresponde(comRelacao(linha), where));
    const ordenar = (lista: T[], orderBy: any): T[] => {
      const criterios = orderBy ? [].concat(orderBy) : [];
      if (criterios.length === 0) return lista;
      return [...lista].sort((a: any, b: any) => {
        for (const criterio of criterios) {
          const [campo, direcao] = Object.entries(criterio)[0] as [
            string,
            string,
          ];
          const va = a[campo] instanceof Date ? a[campo].getTime() : a[campo];
          const vb = b[campo] instanceof Date ? b[campo].getTime() : b[campo];
          if (va === vb) continue;
          const menor = va < vb ? -1 : 1;
          return direcao === 'desc' ? -menor : menor;
        }
        return 0;
      });
    };
    const aplicar = (linha: any, data: Record<string, any>) => {
      for (const [campo, valor] of Object.entries(data)) {
        if (valor === undefined) continue;
        if (ehCondicao(valor) && 'increment' in valor) {
          linha[campo] = Number(linha[campo] ?? 0) + Number(valor.increment);
        } else {
          linha[campo] = valor;
        }
      }
    };
    const executar = <R>(fn: () => R): Promise<R> => {
      const falha = this.falhas.get(nome);
      if (falha) {
        this.falhas.delete(nome);
        return Promise.reject(falha);
      }
      try {
        return Promise.resolve(fn());
      } catch (erro) {
        return Promise.reject(erro as Error);
      }
    };

    return {
      findFirst: (args: any = {}) =>
        executar(() => {
          const [achada] = ordenar(filtrar(args.where), args.orderBy);
          return achada ? comRelacao(achada) : null;
        }),
      findUnique: (args: any = {}) =>
        executar(() => {
          const [achada] = filtrar(args.where);
          return achada ? comRelacao(achada) : null;
        }),
      findMany: (args: any = {}) =>
        executar(() => {
          const achadas = ordenar(filtrar(args.where), args.orderBy);
          const limite = args.take ?? achadas.length;
          return achadas.slice(0, limite).map(comRelacao);
        }),
      count: (args: any = {}) => executar(() => filtrar(args.where).length),
      create: (args: any) =>
        executar(() => {
          const nova: any = {
            id: this.proximoId++,
            ...(opcoes.padrao?.() ?? {}),
            ...args.data,
          };
          const unico = opcoes.unico;
          if (
            unico &&
            nova[unico] != null &&
            linhas().some((l: any) => l[unico] === nova[unico])
          ) {
            throw erroDeUnicidade();
          }
          linhas().push(nova as T);
          return { ...nova };
        }),
      update: (args: any) =>
        executar(() => {
          const [achada] = filtrar(args.where);
          if (!achada) {
            throw Object.assign(new Error('Record not found'), {
              code: 'P2025',
            });
          }
          aplicar(achada, args.data);
          return comRelacao(achada);
        }),
      updateMany: (args: any) =>
        executar(() => {
          const achadas = filtrar(args.where);
          for (const linha of achadas) aplicar(linha, args.data);
          return { count: achadas.length };
        }),
    };
  }

  private corresponde(linha: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([campo, cond]) => {
      if (cond === undefined) return true;
      if (campo === 'AND') {
        return [].concat(cond as any).every((c) => this.corresponde(linha, c));
      }
      if (campo === 'OR') {
        return (cond as any[]).some((c) => this.corresponde(linha, c));
      }
      if (campo === 'NOT') return !this.corresponde(linha, cond);
      const valor = linha?.[campo];
      if (campo === 'user') return !!valor && this.corresponde(valor, cond);
      if (ehCondicao(cond)) return compara(valor, cond);
      return iguais(valor, cond);
    });
  }
}
