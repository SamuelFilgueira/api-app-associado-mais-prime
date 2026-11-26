import {
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  baseDoToken,
  contextoComSessao,
  sessaoDoApp,
} from 'src/beneficios/helpers/alloyal-contexto';
import {
  ERROS_FIXOS_ALLOYAL,
  RotaAlloyal,
  comErroDeContrato,
  descreverErro,
} from 'src/beneficios/helpers/alloyal-erro-de-contrato';
import { DomainError, IntegrationError } from 'src/shared/erros/erros';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

describe('contrato de erro das rotas /alloyal/*', () => {
  let logError: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  const recusa = () =>
    new IntegrationError({
      vendor: 'alloyal',
      tipo: 'recusado',
      base: 'MAIS_PRIME',
      statusVendor: 422,
      detalhes: {
        operacao: 'cupom_resgatar',
        motivo: 'Alloyal respondeu HTTP 422',
        respostaVendor: '{"errors":["cupom esgotado"]}',
      },
    });

  const capturar = async (rota: RotaAlloyal, erro: unknown) => {
    const lancado: unknown = await comErroDeContrato(rota, () => {
      throw erro;
    }).catch((e: unknown) => e);
    return lancado as HttpException;
  };

  it('a tabela É o contrato com o app: 20 rotas, status e mensagem fixos', () => {
    const tabela = Object.fromEntries(
      Object.entries(ERROS_FIXOS_ALLOYAL).map(([rota, erro]) => [
        rota,
        `${erro.status} ${erro.mensagem}`,
      ]),
    );

    expect(tabela).toEqual({
      login: '401 Erro ao fazer login na API Alloyal',
      categorias: '500 Erro ao buscar categorias',
      organizacoesDaCategoria: '500 Erro ao buscar organizações da categoria',
      organizacoes: '500 Erro ao buscar organizações',
      organizacoesProximas: '500 Erro ao buscar organizações mais próximas',
      filiais: '500 Erro ao buscar filiais da organização',
      destaquesProximos: '500 Erro ao buscar organizações em destaque próximas',
      destaquesOnline: '500 Erro ao buscar organizações online em destaque',
      promocoes: '500 Erro ao buscar promoções',
      cashbackExtrato: '500 Erro ao buscar transações de cashback',
      cashbackResgate: '500 Erro ao solicitar resgate de cashback',
      usuarioCriar: '500 Erro ao criar usuário na API Alloyal',
      usuarioAtualizar: '500 Erro ao atualizar usuário na API Alloyal',
      usuarioBuscar: '500 Erro ao buscar usuário por CPF',
      cuponsDaOrganizacao: '500 Erro ao buscar cupons da organização',
      cuponsDaFilial: '500 Erro ao buscar cupons da filial',
      cupomDetalhe: '500 Erro ao buscar detalhes do cupom',
      cupomResgatarComCodigo: '500 Erro ao resgatar cupom com código',
      pedidos: '500 Erro ao listar resgates de cupons',
      cupomResgatar: '500 Erro ao resgatar cupom genérico',
    });
  });

  it('sem erro, devolve o resultado (síncrono ou promessa) e não loga nada', async () => {
    await expect(comErroDeContrato('pedidos', () => [1])).resolves.toEqual([1]);
    await expect(
      comErroDeContrato('pedidos', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');

    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each(Object.keys(ERROS_FIXOS_ALLOYAL) as RotaAlloyal[])(
    '%s: qualquer falha vira o erro fixo da rota, com corpo { statusCode, message }',
    async (rota) => {
      const fixo = ERROS_FIXOS_ALLOYAL[rota];

      for (const falha of [
        recusa(),
        new IntegrationError({ vendor: 'alloyal', tipo: 'timeout' }),
        new UnauthorizedException('Base de origem não configurada no token'),
        new BaseNaoResolvidaError('teste', 'X'),
        new TypeError("Cannot read properties of undefined (reading 'map')"),
        'texto solto',
      ]) {
        const lancado = await capturar(rota, falha);

        expect(lancado).toBeInstanceOf(HttpException);
        expect(lancado.getStatus()).toBe(fixo.status);
        // Resposta em texto: o filtro global monta { statusCode, message }.
        expect(lancado.getResponse()).toBe(fixo.mensagem);
      }
    },
  );

  it('falha síncrona e rejeição de promessa são convertidas do mesmo jeito', async () => {
    const sincrona = await comErroDeContrato('pedidos', () => {
      throw new Error('antes de qualquer await');
    }).catch((e: unknown) => e);
    const assincrona = await comErroDeContrato('pedidos', () =>
      Promise.reject(new Error('depois')),
    ).catch((e: unknown) => e);

    expect((sincrona as HttpException).getStatus()).toBe(500);
    expect((assincrona as HttpException).getStatus()).toBe(500);
  });

  describe('recusa de posse (403)', () => {
    const outraConta = () =>
      new ForbiddenException(
        'Você não tem permissão para acessar os dados de outra conta',
      );

    it.each(['usuarioCriar', 'usuarioAtualizar', 'usuarioBuscar'] as const)(
      '%s: o 403 passa como está, sem log de erro',
      async (rota) => {
        const original = outraConta();

        expect(await capturar(rota, original)).toBe(original);
        expect(logError).not.toHaveBeenCalled();
      },
    );

    it('só essas três rotas deixam o 403 passar', async () => {
      const passam = (Object.keys(ERROS_FIXOS_ALLOYAL) as RotaAlloyal[]).filter(
        (rota) =>
          (ERROS_FIXOS_ALLOYAL[rota] as { passaRecusaDePosse?: true })
            .passaRecusaDePosse,
      );
      expect(passam).toEqual([
        'usuarioCriar',
        'usuarioAtualizar',
        'usuarioBuscar',
      ]);

      const lancado = await capturar('categorias', outraConta());
      expect(lancado.getStatus()).toBe(500);
      expect(lancado.getResponse()).toBe('Erro ao buscar categorias');
    });

    it('nas rotas de usuário, as outras falhas continuam virando o erro fixo', async () => {
      const lancado = await capturar('usuarioAtualizar', recusa());

      expect(lancado.getStatus()).toBe(500);
      expect(lancado.getResponse()).toBe(
        'Erro ao atualizar usuário na API Alloyal',
      );
    });
  });

  describe('log do erro original', () => {
    it('traz o erro tipado: vendor, tipo, status da Alloyal, operação e base', async () => {
      await capturar('cupomResgatar', recusa());

      expect(logError).toHaveBeenCalledTimes(1);
      const [linha, pilha] = logError.mock.calls[0] as [string, unknown];
      expect(linha).toBe(
        '[cupomResgatar] IntegrationError vendor=alloyal tipo=recusado statusVendor=422' +
          ' operacao=cupom_resgatar base=MAIS_PRIME code=INTEGRACAO_RECUSADO' +
          ' motivo=Alloyal respondeu HTTP 422' +
          ' → HTTP 500 "Erro ao resgatar cupom genérico"',
      );
      // Erro já classificado: a pilha não acrescenta nada.
      expect(pilha).toBeUndefined();
    });

    it('login (401) loga como aviso; as demais (500) como erro', async () => {
      await capturar('login', recusa());

      expect(logError).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn.mock.calls[0][0]).toContain(
        '→ HTTP 401 "Erro ao fazer login na API Alloyal"',
      );
    });

    it('erro inesperado (bug) vai com a pilha', async () => {
      const bug = new TypeError('x is not a function');

      await capturar('categorias', bug);

      const [linha, pilha] = logError.mock.calls[0] as [string, string];
      expect(linha).toContain('TypeError: x is not a function');
      expect(pilha).toBe(bug.stack);
    });

    it('descreverErro cobre cada família', () => {
      expect(
        descreverErro(
          new IntegrationError({
            vendor: 'alloyal',
            tipo: 'nao_configurada',
            base: 'MAIS_PRIME_RS',
            detalhes: { operacao: 'login', faltando: 'API_SECRET_ALLOYAL_RS' },
          }),
        ),
      ).toBe(
        'IntegrationError vendor=alloyal tipo=nao_configurada statusVendor=(sem resposta)' +
          ' operacao=login base=MAIS_PRIME_RS code=INTEGRACAO_NAO_CONFIGURADA' +
          ' motivo=API_SECRET_ALLOYAL_RS',
      );
      expect(
        descreverErro(
          new IntegrationError({ vendor: 'alloyal', tipo: 'timeout' }),
        ),
      ).toBe(
        'IntegrationError vendor=alloyal tipo=timeout statusVendor=(sem resposta)' +
          ' operacao=? base=? code=INTEGRACAO_TIMEOUT',
      );
      expect(descreverErro(new BaseNaoResolvidaError('teste', 'X'))).toMatch(
        /^BaseNaoResolvidaError code=BASE_NAO_RESOLVIDA: /,
      );
      expect(descreverErro(new DomainError('QUALQUER', 'Regra violada'))).toBe(
        'DomainError code=QUALQUER: Regra violada',
      );
      expect(descreverErro(new UnauthorizedException('Sem base'))).toBe(
        'UnauthorizedException status=401: Sem base',
      );
      expect(descreverErro(new RangeError('fora'))).toBe('RangeError: fora');
      expect(descreverErro('texto')).toBe('erro não tipado: texto');
    });

    it('o log não repete o corpo devolvido pela Alloyal (fica no log do client)', async () => {
      await capturar('cupomResgatar', recusa());

      expect(logError.mock.calls[0][0]).not.toContain('cupom esgotado');
    });
  });
});

describe('contexto das rotas /alloyal/*', () => {
  it('baseDoToken: sem base → 401; base de outro deploy → erro de base; válida → ela mesma', () => {
    expect(() => baseDoToken(undefined)).toThrow(UnauthorizedException);
    expect(() => baseDoToken('')).toThrow(
      'Base de origem não configurada no token',
    );
    expect(() => baseDoToken('OUTRA_EMPRESA')).toThrow(BaseNaoResolvidaError);
    expect(baseDoToken('MAIS_PRIME_RS')).toBe('MAIS_PRIME_RS');
  });

  it('sessaoDoApp: os três cabeçalhos são obrigatórios', () => {
    expect(sessaoDoApp({ uid: 'u', client: 'c', accessToken: 't' })).toEqual({
      uid: 'u',
      client: 'c',
      accessToken: 't',
    });

    for (const incompleta of [
      {},
      { uid: 'u', client: 'c' },
      { uid: 'u', accessToken: 't' },
      { client: 'c', accessToken: 't' },
      { uid: '', client: 'c', accessToken: 't' },
    ]) {
      const erro = (() => {
        try {
          sessaoDoApp(incompleta);
        } catch (e) {
          return e as HttpException;
        }
      })();
      expect(erro).toBeInstanceOf(HttpException);
      expect(erro?.getStatus()).toBe(401);
      expect(erro?.message).toBe(
        'Headers de autenticação da Alloyal ausentes (uid, client, access-token)',
      );
    }
  });

  it('contextoComSessao: devolve base e sessão; falta de sessão é apontada antes da base', () => {
    expect(
      contextoComSessao('MAIS_PRIME', {
        uid: 'u',
        client: 'c',
        accessToken: 't',
      }),
    ).toEqual({
      base: 'MAIS_PRIME',
      sessao: { uid: 'u', client: 'c', accessToken: 't' },
    });
    expect(() => contextoComSessao(undefined, {})).toThrow(
      'Headers de autenticação da Alloyal ausentes',
    );
    expect(() =>
      contextoComSessao(undefined, { uid: 'u', client: 'c', accessToken: 't' }),
    ).toThrow(UnauthorizedException);
  });
});
