import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

/**
 * Prisma em memória, restrito aos modelos da revistoria, para os testes de
 * UNIDADE do módulo. Implementa só as formas de consulta que o módulo usa
 * (`where` com igualdade, `in`, `not`, `lt`, `contains`, `OR`/`NOT`, filtros
 * de relação `some`/`none`, `select` com relações e `_count`).
 *
 * Cada chamada é atômica (JavaScript de uma thread só), então duas operações
 * concorrentes se intercalam nos `await` — é o que permite reproduzir a
 * corrida "duas aprovações leem o mesmo estado" sem banco.
 *
 * Não simula trava de linha nem isolamento: isso é coberto pelos testes de
 * integração (`test/integracao/revistoria-*.integration-spec.ts`).
 */
type Linha = Record<string, unknown>;

/** Linha devolvida pela semeadura: o id é sempre numérico. */
export type LinhaSemeada = { id: number } & Linha;

export type ModeloRevistoria =
  | 'user'
  | 'userVehicle'
  | 'reinspection'
  | 'reinspectionPhoto'
  | 'reinspectionTemplatePhoto'
  | 'reinspectionHinovaEnvio';

interface Relacao {
  tipo: 'um' | 'muitos';
  modelo: ModeloRevistoria;
  /** `um`: FK nesta linha; `muitos`: FK na linha do outro modelo. */
  chave: string;
}

const RELACOES: Record<ModeloRevistoria, Record<string, Relacao>> = {
  user: {},
  userVehicle: {
    user: { tipo: 'um', modelo: 'user', chave: 'userId' },
    reinspections: {
      tipo: 'muitos',
      modelo: 'reinspection',
      chave: 'userVehicleId',
    },
  },
  reinspection: {
    userVehicle: { tipo: 'um', modelo: 'userVehicle', chave: 'userVehicleId' },
    photos: {
      tipo: 'muitos',
      modelo: 'reinspectionPhoto',
      chave: 'reinspectionId',
    },
    hinovaEnvios: {
      tipo: 'muitos',
      modelo: 'reinspectionHinovaEnvio',
      chave: 'reinspectionId',
    },
  },
  reinspectionPhoto: {
    reinspection: {
      tipo: 'um',
      modelo: 'reinspection',
      chave: 'reinspectionId',
    },
    templatePhoto: {
      tipo: 'um',
      modelo: 'reinspectionTemplatePhoto',
      chave: 'templatePhotoId',
    },
  },
  reinspectionTemplatePhoto: {},
  reinspectionHinovaEnvio: {
    reinspection: {
      tipo: 'um',
      modelo: 'reinspection',
      chave: 'reinspectionId',
    },
  },
};

/** Chaves únicas compostas aceitas em `where` (`{ a_b: { a, b } }`). */
const CHAVES_COMPOSTAS = new Set(['vehicleType_ordem']);

/** Valores padrão do schema, por modelo. */
const PADROES: Record<ModeloRevistoria, (agora: Date) => Linha> = {
  user: () => ({ baseOrigin: 'MAIS_PRIME', cpf: null, role: 'USER' }),
  userVehicle: () => ({ plate: null }),
  reinspection: (agora) => ({
    status: 'PENDENTE',
    codigoVeiculo: null,
    hinovaEnvioStatus: 'NAO_ENVIADA',
    hinovaUltimoEnvioEm: null,
    boletoStatus: 'NAO_GERADO',
    boletoTentativas: 0,
    boletoUltimaTentativaEm: null,
    boletoProximaTentativaEm: null,
    boletoRetryInicioEm: null,
    boletoUltimoErro: null,
    boletoNossoNumero: null,
    boletoOrigem: null,
    boletoLeaseAte: null,
    boletoLeaseDono: null,
    hinovaEnvioLeaseAte: null,
    createdAt: agora,
    updatedAt: agora,
  }),
  reinspectionPhoto: (agora) => ({
    codigoTipo: null,
    url: null,
    hinovaSituacao: null,
    sentToHinova: false,
    hinovaEnviadaEm: null,
    hinovaTentativas: 0,
    hinovaUltimoErro: null,
    templatePhotoId: null,
    createdAt: agora,
  }),
  reinspectionTemplatePhoto: (agora) => ({
    createdAt: agora,
    updatedAt: agora,
  }),
  reinspectionHinovaEnvio: (agora) => ({
    codigoVeiculo: null,
    adminPanelUserId: null,
    adminPanelUserEmail: null,
    totalFotos: 0,
    totalInseridas: 0,
    totalFalhas: 0,
    httpStatus: null,
    responseBody: null,
    errorMessage: null,
    duracaoMs: null,
    createdAt: agora,
  }),
};

/** Modelos com `@updatedAt`. */
const COM_UPDATED_AT = new Set<ModeloRevistoria>([
  'reinspection',
  'reinspectionTemplatePhoto',
]);

function ehObjetoSimples(valor: unknown): valor is Linha {
  return (
    valor !== null &&
    typeof valor === 'object' &&
    !(valor instanceof Date) &&
    !Array.isArray(valor)
  );
}

function iguais(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

function comparar(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function registroNaoEncontrado(modelo: string): Error {
  return Object.assign(new Error(`Registro não encontrado: ${modelo}`), {
    code: 'P2025',
  });
}

class Delegado {
  constructor(
    private readonly banco: PrismaRevistoriaMemoria,
    private readonly modelo: ModeloRevistoria,
  ) {}

  private get linhas(): Linha[] {
    return this.banco.tabelas[this.modelo];
  }

  findUnique(args: Linha): Promise<Linha | null> {
    const linha = this.linhas.find((l) =>
      this.banco.casa(this.modelo, l, args.where as Linha | undefined),
    );
    return Promise.resolve(
      linha ? this.banco.projetar(this.modelo, linha, args) : null,
    );
  }

  async findUniqueOrThrow(args: Linha): Promise<Linha> {
    const linha = await this.findUnique(args);
    if (!linha) throw registroNaoEncontrado(this.modelo);
    return linha;
  }

  async findFirst(args: Linha = {}): Promise<Linha | null> {
    const [primeira] = await this.findMany({ ...args, take: 1 });
    return primeira ?? null;
  }

  findMany(args: Linha = {}): Promise<Linha[]> {
    let linhas = this.linhas.filter((l) =>
      this.banco.casa(this.modelo, l, args.where as Linha | undefined),
    );
    linhas = this.banco.ordenar(linhas, args.orderBy);
    if (typeof args.take === 'number') linhas = linhas.slice(0, args.take);
    return Promise.resolve(
      linhas.map((l) => this.banco.projetar(this.modelo, l, args)),
    );
  }

  count(args: Linha = {}): Promise<number> {
    return Promise.resolve(
      this.linhas.filter((l) =>
        this.banco.casa(this.modelo, l, args.where as Linha | undefined),
      ).length,
    );
  }

  create(args: Linha): Promise<Linha> {
    const linha = this.banco.inserir(this.modelo, args.data as Linha);
    return Promise.resolve(this.banco.projetar(this.modelo, linha, args));
  }

  createMany(args: Linha): Promise<{ count: number }> {
    const itens = args.data as Linha[];
    for (const item of itens) this.banco.inserir(this.modelo, item);
    return Promise.resolve({ count: itens.length });
  }

  update(args: Linha): Promise<Linha> {
    const linha = this.linhas.find((l) =>
      this.banco.casa(this.modelo, l, args.where as Linha | undefined),
    );
    if (!linha) return Promise.reject(registroNaoEncontrado(this.modelo));
    this.banco.aplicar(this.modelo, linha, args.data as Linha);
    return Promise.resolve(this.banco.projetar(this.modelo, linha, args));
  }

  updateMany(args: Linha): Promise<{ count: number }> {
    const alvos = this.linhas.filter((l) =>
      this.banco.casa(this.modelo, l, args.where as Linha | undefined),
    );
    for (const linha of alvos) {
      this.banco.aplicar(this.modelo, linha, args.data as Linha);
    }
    return Promise.resolve({ count: alvos.length });
  }

  upsert(args: Linha): Promise<Linha> {
    const existente = this.linhas.find((l) =>
      this.banco.casa(this.modelo, l, args.where as Linha | undefined),
    );
    if (existente) {
      this.banco.aplicar(this.modelo, existente, args.update as Linha);
      return Promise.resolve(this.banco.projetar(this.modelo, existente, args));
    }
    return this.create({ ...args, data: args.create });
  }
}

export class PrismaRevistoriaMemoria {
  readonly tabelas: Record<ModeloRevistoria, Linha[]> = {
    user: [],
    userVehicle: [],
    reinspection: [],
    reinspectionPhoto: [],
    reinspectionTemplatePhoto: [],
    reinspectionHinovaEnvio: [],
  };

  readonly user = new Delegado(this, 'user');
  readonly userVehicle = new Delegado(this, 'userVehicle');
  readonly reinspection = new Delegado(this, 'reinspection');
  readonly reinspectionPhoto = new Delegado(this, 'reinspectionPhoto');
  readonly reinspectionTemplatePhoto = new Delegado(
    this,
    'reinspectionTemplatePhoto',
  );
  readonly reinspectionHinovaEnvio = new Delegado(
    this,
    'reinspectionHinovaEnvio',
  );

  private proximoId = 1;
  private ultimoInstante = 0;

  /** Para injetar onde o tipo esperado é o `PrismaService`. */
  comoPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  /** Fixa o id da próxima linha criada (specs que conferem o id gerado). */
  definirProximoId(id: number): void {
    this.proximoId = id;
  }

  /** Relógio monotônico: duas linhas nunca nascem no mesmo milissegundo. */
  agora(): Date {
    this.ultimoInstante = Math.max(Date.now(), this.ultimoInstante + 1);
    return new Date(this.ultimoInstante);
  }

  // ── Semeadura ─────────────────────────────────────────────────────────────

  comUsuario(dados: Linha = {}): LinhaSemeada {
    return this.inserir('user', dados);
  }

  comVeiculo(dados: Linha = {}): LinhaSemeada {
    const userId = (dados.userId as number | undefined) ?? this.comUsuario().id;
    return this.inserir('userVehicle', {
      chassi: `CHASSI${this.proximoId}`,
      plate: `ABC${this.proximoId}`,
      ...dados,
      userId,
    });
  }

  comRevistoria(dados: Linha): LinhaSemeada {
    return this.inserir('reinspection', {
      vehicleType: 'VEICULOS_LEVES',
      ...dados,
    });
  }

  comFoto(dados: Linha): LinhaSemeada {
    return this.inserir('reinspectionPhoto', {
      nomeArquivo: `foto_ordem_${this.proximoId}.jpg`,
      status: 'PENDENTE',
      url: `uploads/reinspection-photos/${this.proximoId}.jpg`,
      ...dados,
    });
  }

  comTemplate(dados: Linha): LinhaSemeada {
    return this.inserir('reinspectionTemplatePhoto', {
      vehicleType: 'VEICULOS_LEVES',
      photoUrl: `uploads/reinspection-templates/${this.proximoId}.jpg`,
      ...dados,
    });
  }

  linha(modelo: ModeloRevistoria, id: number): Linha {
    const linha = this.tabelas[modelo].find((l) => l.id === id);
    if (!linha) throw registroNaoEncontrado(modelo);
    return linha;
  }

  // ── API do Prisma usada pelo módulo ───────────────────────────────────────

  async $transaction(arg: unknown): Promise<unknown> {
    if (typeof arg !== 'function') {
      return Promise.all(arg as Array<Promise<unknown>>);
    }
    // Transação interativa: em erro, desfaz o que ela gravou.
    const retrato = this.fotografar();
    try {
      return await (arg as (tx: this) => Promise<unknown>)(this);
    } catch (erro) {
      this.restaurar(retrato);
      throw erro;
    }
  }

  /** `SELECT ... FOR UPDATE`: sem trava em memória. */
  $queryRaw(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  // ── Motor ─────────────────────────────────────────────────────────────────

  inserir(modelo: ModeloRevistoria, dados: Linha): LinhaSemeada {
    const linha: LinhaSemeada = {
      id: this.proximoId++,
      ...PADROES[modelo](this.agora()),
    };
    for (const [campo, valor] of Object.entries(dados)) {
      if (valor !== undefined) linha[campo] = this.valorGravavel(valor);
    }
    if (typeof linha.id === 'number' && linha.id >= this.proximoId) {
      this.proximoId = linha.id + 1;
    }
    this.tabelas[modelo].push(linha);
    return linha;
  }

  aplicar(modelo: ModeloRevistoria, linha: Linha, dados: Linha): void {
    for (const [campo, valor] of Object.entries(dados)) {
      if (valor === undefined) continue;
      if (ehObjetoSimples(valor) && 'increment' in valor) {
        linha[campo] =
          ((linha[campo] as number | null) ?? 0) + (valor.increment as number);
      } else if (ehObjetoSimples(valor) && 'set' in valor) {
        linha[campo] = valor.set;
      } else {
        linha[campo] = this.valorGravavel(valor);
      }
    }
    if (COM_UPDATED_AT.has(modelo)) linha.updatedAt = this.agora();
  }

  casa(modelo: ModeloRevistoria, linha: Linha, where?: Linha): boolean {
    if (!where) return true;
    return Object.entries(where).every(([campo, condicao]) => {
      if (condicao === undefined) return true;
      const lista = (): Linha[] =>
        Array.isArray(condicao) ? (condicao as Linha[]) : [condicao as Linha];

      if (campo === 'AND')
        return lista().every((w) => this.casa(modelo, linha, w));
      if (campo === 'OR')
        return lista().some((w) => this.casa(modelo, linha, w));
      if (campo === 'NOT')
        return !lista().some((w) => this.casa(modelo, linha, w));

      if (CHAVES_COMPOSTAS.has(campo)) {
        return Object.entries(condicao as Linha).every(([c, v]) =>
          iguais(linha[c], v),
        );
      }

      const relacao = RELACOES[modelo][campo];
      if (relacao?.tipo === 'um') {
        const alvo = this.alvoUm(relacao, linha);
        const filtro = (condicao as Linha).is ?? condicao;
        return !!alvo && this.casa(relacao.modelo, alvo, filtro as Linha);
      }
      if (relacao?.tipo === 'muitos') {
        const itens = this.alvosMuitos(relacao, linha);
        const { some, none, every } = condicao as {
          some?: Linha;
          none?: Linha;
          every?: Linha;
        };
        if (some && !itens.some((i) => this.casa(relacao.modelo, i, some))) {
          return false;
        }
        if (none && itens.some((i) => this.casa(relacao.modelo, i, none))) {
          return false;
        }
        if (every && !itens.every((i) => this.casa(relacao.modelo, i, every))) {
          return false;
        }
        return true;
      }

      return this.casaEscalar(linha[campo], condicao);
    });
  }

  projetar(modelo: ModeloRevistoria, linha: Linha, args?: Linha): Linha {
    const select = args?.select as Linha | undefined;
    if (!select) return { ...linha };

    const saida: Linha = {};
    for (const [campo, opcao] of Object.entries(select)) {
      if (!opcao) continue;

      if (campo === '_count') {
        const contagem: Linha = {};
        for (const nome of Object.keys((opcao as Linha).select as Linha)) {
          contagem[nome] = this.alvosMuitos(
            RELACOES[modelo][nome],
            linha,
          ).length;
        }
        saida._count = contagem;
        continue;
      }

      const relacao = RELACOES[modelo][campo];
      if (!relacao) {
        saida[campo] = linha[campo];
        continue;
      }

      const sub = opcao === true ? undefined : (opcao as Linha);
      if (relacao.tipo === 'um') {
        const alvo = this.alvoUm(relacao, linha);
        saida[campo] = alvo ? this.projetar(relacao.modelo, alvo, sub) : null;
      } else {
        let itens = this.alvosMuitos(relacao, linha);
        if (sub?.where) {
          itens = itens.filter((i) =>
            this.casa(relacao.modelo, i, sub.where as Linha),
          );
        }
        saida[campo] = this.ordenar(itens, sub?.orderBy).map((i) =>
          this.projetar(relacao.modelo, i, sub),
        );
      }
    }
    return saida;
  }

  ordenar(linhas: Linha[], orderBy?: unknown): Linha[] {
    const criterios = (
      Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
    ) as Linha[];
    // Empate decide pelo id, para a ordem ser determinística.
    return [...linhas].sort((a, b) => {
      for (const criterio of criterios) {
        for (const [campo, direcao] of Object.entries(criterio)) {
          const resultado = comparar(a[campo], b[campo]);
          if (resultado !== 0)
            return direcao === 'desc' ? -resultado : resultado;
        }
      }
      const desc = criterios.some((c) => Object.values(c).includes('desc'));
      const porId = comparar(a.id, b.id);
      return desc ? -porId : porId;
    });
  }

  private casaEscalar(valor: unknown, condicao: unknown): boolean {
    if (!ehObjetoSimples(condicao)) return iguais(valor, condicao);

    return Object.entries(condicao).every(([operador, alvo]) => {
      switch (operador) {
        case 'equals':
          return iguais(valor, alvo);
        case 'in':
          return (alvo as unknown[]).some((a) => iguais(valor, a));
        case 'notIn':
          return !(alvo as unknown[]).some((a) => iguais(valor, a));
        case 'not':
          return ehObjetoSimples(alvo)
            ? !this.casaEscalar(valor, alvo)
            : !iguais(valor, alvo);
        // Comparação com NULL nunca é verdadeira, como no SQL.
        case 'lt':
          return valor != null && comparar(valor, alvo) < 0;
        case 'lte':
          return valor != null && comparar(valor, alvo) <= 0;
        case 'gt':
          return valor != null && comparar(valor, alvo) > 0;
        case 'gte':
          return valor != null && comparar(valor, alvo) >= 0;
        case 'contains':
          return (
            typeof valor === 'string' &&
            valor.toLowerCase().includes(String(alvo).toLowerCase())
          );
        default:
          throw new Error(`Operador não suportado no dublê: ${operador}`);
      }
    });
  }

  private alvoUm(relacao: Relacao, linha: Linha): Linha | undefined {
    const fk = linha[relacao.chave] as number | null;
    if (fk == null) return undefined;
    return this.tabelas[relacao.modelo].find((l) => l.id === fk);
  }

  private alvosMuitos(relacao: Relacao, linha: Linha): Linha[] {
    return this.tabelas[relacao.modelo].filter(
      (l) => l[relacao.chave] === linha.id,
    );
  }

  /** `Prisma.JsonNull` / `Prisma.DbNull` viram `null` na linha. */
  private valorGravavel(valor: unknown): unknown {
    return valor === Prisma.JsonNull || valor === Prisma.DbNull ? null : valor;
  }

  private fotografar(): Record<ModeloRevistoria, Linha[]> {
    const copia = {} as Record<ModeloRevistoria, Linha[]>;
    for (const modelo of Object.keys(this.tabelas) as ModeloRevistoria[]) {
      copia[modelo] = this.tabelas[modelo].map((l) => ({ ...l }));
    }
    return copia;
  }

  private restaurar(retrato: Record<ModeloRevistoria, Linha[]>): void {
    for (const modelo of Object.keys(retrato) as ModeloRevistoria[]) {
      this.tabelas[modelo].splice(
        0,
        this.tabelas[modelo].length,
        ...retrato[modelo],
      );
    }
  }
}
