/**
 * `prisma.reinspection` em memória para os testes de unidade do boleto de
 * reativação: UMA revistoria, com `updateMany` que respeita o `where` — é o
 * que permite exercitar o lease e as escritas condicionais sem banco.
 *
 * Cobre só os operadores que o `BoletoReativacaoRepository` usa: igualdade,
 * `in`, `not`, `lt`, `lte`, `null` e `OR`/`AND`. A prova contra o banco real
 * fica em `test/integracao/boleto-lease.integration-spec.ts`.
 */
type Linha = Record<string, unknown>;

function valorCasa(valor: unknown, condicao: unknown): boolean {
  if (condicao === null || typeof condicao !== 'object') {
    return valor === condicao;
  }
  if (condicao instanceof Date) {
    return valor instanceof Date && valor.getTime() === condicao.getTime();
  }
  const c = condicao as Record<string, unknown>;
  if ('in' in c) return (c.in as unknown[]).includes(valor);
  if ('not' in c) return valor !== c.not;
  const tempo = (v: unknown) => (v instanceof Date ? v.getTime() : null);
  if ('lt' in c) {
    return tempo(valor) !== null && tempo(valor)! < tempo(c.lt)!;
  }
  if ('lte' in c) {
    return tempo(valor) !== null && tempo(valor)! <= tempo(c.lte)!;
  }
  throw new Error(`operador não suportado no fake: ${JSON.stringify(c)}`);
}

export function linhaCasa(linha: Linha, where: Linha): boolean {
  return Object.entries(where).every(([campo, condicao]) => {
    if (campo === 'OR') {
      return (condicao as Linha[]).some((w) => linhaCasa(linha, w));
    }
    if (campo === 'AND') {
      return (condicao as Linha[]).every((w) => linhaCasa(linha, w));
    }
    return valorCasa(linha[campo], condicao);
  });
}

export function revistoriaEmMemoria(inicial: Linha = {}) {
  const linha: Linha = {
    id: 10,
    status: 'APROVADA',
    codigoVeiculo: 777,
    boletoStatus: 'NAO_GERADO',
    boletoTentativas: 0,
    boletoNossoNumero: null,
    boletoOrigem: null,
    boletoUltimaTentativaEm: null,
    boletoProximaTentativaEm: null,
    boletoRetryInicioEm: null,
    boletoUltimoErro: null,
    boletoLeaseAte: null,
    boletoLeaseDono: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    userVehicle: {
      id: 5,
      chassi: 'CHASSI123',
      plate: 'ABC1D23',
      user: { cpf: '529.982.247-25', baseOrigin: 'MAIS_PRIME' },
    },
    ...inicial,
  };

  const reinspection = {
    findUnique: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(where.id === linha.id ? { ...linha } : null),
    ),
    updateMany: jest.fn(({ where, data }: { where: Linha; data: Linha }) => {
      if (!linhaCasa(linha, where)) return Promise.resolve({ count: 0 });
      Object.assign(linha, data);
      return Promise.resolve({ count: 1 });
    }),
    findMany: jest.fn(({ where }: { where: Linha }) =>
      Promise.resolve(linhaCasa(linha, where) ? [{ id: linha.id }] : []),
    ),
  };

  return { linha, prisma: { reinspection } };
}
