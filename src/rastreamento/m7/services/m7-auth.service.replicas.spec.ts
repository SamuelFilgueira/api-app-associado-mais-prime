import { InternalServerErrorException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import {
  M7AuthService,
  M7_PAUSA_APOS_FALHA_MS,
  M7_RENOVACAO_PERIODICA_MS,
} from 'src/rastreamento/m7/services/m7-auth.service';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/** Erro do axios com o status informado (como a M7 recusando o token). */
function erroHttp(status: number, data: unknown = {}): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, data, statusText: '', headers: {}, config: {} as never },
  );
}

/**
 * A sessão da M7 saiu da memória de cada processo e foi para o
 * `VendorSessionStore`. Duas instâncias com o MESMO store simulam duas
 * réplicas da API.
 */
describe('M7AuthService — sessão compartilhada entre réplicas', () => {
  const envOriginal = { ...process.env };
  let store: VendorSessionStore;
  let a: M7AuthService;
  let b: M7AuthService;
  let axiosPost: jest.SpyInstance;
  let logins: number;

  const criar = () => new M7AuthService(new TenantCredentialsRegistry(), store);

  beforeEach(() => {
    process.env.M7_API_BASE_URL = 'https://m7.teste.local/';
    process.env.MO7_TOKEN = 'token-mp';
    process.env.M07_CODIGO = 'codigo-mp';
    process.env.MO7_TOKEN_RS = 'token-rs';
    process.env.M07_CODIGO_RS = 'codigo-rs';
    logins = 0;
    axiosPost = jest.spyOn(axios, 'post').mockImplementation(() => {
      logins += 1;
      return Promise.resolve({
        data: { sucesso: true, token: `sessao-${logins}`, expires_in: 3600 },
      });
    });
    store = VendorSessionStore.emMemoria();
    a = criar();
    b = criar();
  });

  afterEach(() => {
    a.onModuleDestroy();
    b.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = { ...envOriginal };
  });

  it('duas instâncias com o mesmo store fazem um login só', async () => {
    await expect(a.obterToken('MAIS_PRIME')).resolves.toBe('sessao-1');
    await expect(b.obterToken('MAIS_PRIME')).resolves.toBe('sessao-1');

    expect(logins).toBe(1);
  });

  it('chamadas simultâneas na mesma instância compartilham o login', async () => {
    const tokens = await Promise.all([
      a.obterToken('MAIS_PRIME'),
      a.obterToken('MAIS_PRIME'),
      a.obterToken('MAIS_PRIME'),
    ]);

    expect(new Set(tokens)).toEqual(new Set(['sessao-1']));
    expect(logins).toBe(1);
  });

  it('a sessão é por base e usa a credencial da própria base', async () => {
    await a.obterToken('MAIS_PRIME');
    await b.obterToken('MAIS_PRIME_RS');

    expect(logins).toBe(2);
    expect(axiosPost).toHaveBeenNthCalledWith(
      1,
      'https://m7.teste.local/login',
      { codigo: 'codigo-mp', api_m7_token: 'token-mp' },
      expect.anything(),
    );
    expect(axiosPost).toHaveBeenNthCalledWith(
      2,
      'https://m7.teste.local/login',
      { codigo: 'codigo-rs', api_m7_token: 'token-rs' },
      expect.anything(),
    );
  });

  describe('boot (onModuleInit)', () => {
    it('sem sessão guardada: a primeira réplica faz login; a segunda, não', async () => {
      await a.onModuleInit();
      expect(logins).toBe(2); // uma por base configurada

      await b.onModuleInit();
      expect(logins).toBe(2);
      await expect(b.obterToken('MAIS_PRIME')).resolves.toBe(
        await a.obterToken('MAIS_PRIME'),
      );
    });

    it('com token válido guardado não renova no boot', async () => {
      await store.gravar(
        'm7',
        'token:MAIS_PRIME',
        JSON.stringify({
          token: 'guardado',
          expiresIn: 3600,
          obtidoEm: Date.now(),
        }),
        3600,
      );
      delete process.env.MO7_TOKEN_RS;

      await a.onModuleInit();

      expect(logins).toBe(0);
      await expect(a.obterToken('MAIS_PRIME')).resolves.toBe('guardado');
    });

    it('base sem credencial da M7 fica fora do boot, sem erro', async () => {
      delete process.env.MO7_TOKEN_RS;
      delete process.env.M07_CODIGO_RS;

      await expect(a.onModuleInit()).resolves.toBeUndefined();

      expect(logins).toBe(1);
      expect(a.estaConfigurada('MAIS_PRIME')).toBe(true);
      expect(a.estaConfigurada('MAIS_PRIME_RS')).toBe(false);
      expect(a.estaConfigurada('OUTRA_EMPRESA')).toBe(false);
    });

    it('falha de login no boot não derruba o boot', async () => {
      axiosPost.mockRejectedValue(new Error('M7 fora do ar'));

      await expect(a.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('token recusado pela M7', () => {
    it('B teve o token antigo recusado depois de A renovar: adota o de A, sem login', async () => {
      await a.obterToken('MAIS_PRIME'); // sessao-1
      await b.obterToken('MAIS_PRIME'); // adota sessao-1
      await a.renovar('MAIS_PRIME', 'sessao-1'); // sessao-2

      const adotada = await b.renovar('MAIS_PRIME', 'sessao-1');

      expect(adotada.token).toBe('sessao-2');
      expect(logins).toBe(2);
    });

    it('o token guardado é o que foi recusado: aí sim faz login', async () => {
      await a.obterToken('MAIS_PRIME');

      const nova = await b.renovar('MAIS_PRIME', 'sessao-1');

      expect(nova.token).toBe('sessao-2');
      expect(logins).toBe(2);
    });

    it('renovação pedida pelo operador (sem token recusado) sempre faz login', async () => {
      await a.obterToken('MAIS_PRIME');

      await expect(b.renovar('MAIS_PRIME')).resolves.toMatchObject({
        token: 'sessao-2',
        expiresIn: 3600,
      });
    });
  });

  describe('renovação periódica', () => {
    it('sessão renovada há pouco por outra réplica é adotada, sem login', async () => {
      await a.obterToken('MAIS_PRIME');

      const sessao = await b.renovarSeAntiga('MAIS_PRIME');

      expect(sessao.token).toBe('sessao-1');
      expect(logins).toBe(1);
    });

    it('sessão velha: uma réplica renova e a outra adota', async () => {
      jest.useFakeTimers();
      await a.obterToken('MAIS_PRIME');
      jest.setSystemTime(Date.now() + M7_RENOVACAO_PERIODICA_MS);

      await a.renovarSeAntiga('MAIS_PRIME');
      await b.renovarSeAntiga('MAIS_PRIME');

      expect(logins).toBe(2);
      await expect(b.obterToken('MAIS_PRIME')).resolves.toBe('sessao-2');
    });
  });

  describe('falha de login', () => {
    it('não repete o login a cada chamada: espera a pausa', async () => {
      jest.useFakeTimers();
      axiosPost.mockRejectedValue(new Error('M7 fora do ar'));

      await expect(a.obterToken('MAIS_PRIME')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      await expect(a.obterToken('MAIS_PRIME')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(axiosPost).toHaveBeenCalledTimes(1);

      jest.setSystemTime(Date.now() + M7_PAUSA_APOS_FALHA_MS + 1);
      await expect(a.obterToken('MAIS_PRIME')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(axiosPost).toHaveBeenCalledTimes(2);
    });

    it('`sucesso` diferente de true é login recusado', async () => {
      axiosPost.mockResolvedValue({ data: { sucesso: false } });

      await expect(a.obterToken('MAIS_PRIME')).rejects.toThrow(
        'Falha ao renovar token',
      );
    });

    it('a resposta do erro não leva credencial nem nome de variável', async () => {
      delete process.env.MO7_TOKEN;

      const erro = (await a
        .obterToken('MAIS_PRIME')
        .catch((e: unknown) => e)) as Error;

      expect(erro.message).not.toContain('MO7_TOKEN');
      expect(erro.message).not.toContain('codigo-mp');
    });
  });

  describe('RastreamentoM7.executarComReautenticacao', () => {
    it('base desconhecida → erro tipado (antes: TypeError), sem falar com a M7', async () => {
      const m7 = new RastreamentoM7(a);
      const chamada = jest.fn();

      await expect(
        m7.executarComReautenticacao('OUTRA_EMPRESA', chamada),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
      await expect(
        m7.executarComReautenticacao(undefined as never, chamada),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

      expect(chamada).not.toHaveBeenCalled();
      expect(logins).toBe(0);
    });

    it('o erro tipado atravessa os métodos do client sem virar 500 genérico', async () => {
      const m7 = new RastreamentoM7(a);

      await expect(
        m7.ultimaPosicaoM7('cnpj', 'CHASSI', 'OUTRA_EMPRESA'),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
    });

    it('sem sessão: autentica sob demanda e executa a chamada', async () => {
      const m7 = new RastreamentoM7(a);

      await expect(
        m7.executarComReautenticacao('MAIS_PRIME', (token) =>
          Promise.resolve({ status: 200, data: token }),
        ),
      ).resolves.toBe('sessao-1');
    });

    it('401 numa réplica: renova uma vez; a outra adota o token novo sem login', async () => {
      const m7a = new RastreamentoM7(a);
      const m7b = new RastreamentoM7(b);
      await a.obterToken('MAIS_PRIME');
      await b.obterToken('MAIS_PRIME');
      // A M7 passa a recusar a sessao-1.
      const chamada = (token: string) =>
        token === 'sessao-1'
          ? Promise.reject(erroHttp(401))
          : Promise.resolve({ status: 200, data: token });

      await expect(
        m7a.executarComReautenticacao('MAIS_PRIME', chamada),
      ).resolves.toBe('sessao-2');
      await expect(
        m7b.executarComReautenticacao('MAIS_PRIME', chamada),
      ).resolves.toBe('sessao-2');

      expect(logins).toBe(2);
    });

    it('sem conseguir autenticar: o mesmo 500 de sempre ("Token não disponível")', async () => {
      axiosPost.mockRejectedValue(new Error('M7 fora do ar'));
      const m7 = new RastreamentoM7(a);

      await expect(
        m7.executarComReautenticacao('MAIS_PRIME', jest.fn()),
      ).rejects.toEqual(
        new InternalServerErrorException('Token não disponível'),
      );
    });

    it('recusa do comando pela M7 (404 com mensagem): 400 com mensagem neutra e code', async () => {
      const m7 = new RastreamentoM7(a);
      jest
        .spyOn(axios, 'post')
        .mockImplementation((url: string) =>
          url.endsWith('login')
            ? Promise.resolve({ data: { sucesso: true, token: 't' } })
            : Promise.reject(
                erroHttp(404, { erro: 'TEXTO CRU DO VENDOR sobre o veículo' }),
              ),
        );

      const erro = (await m7
        .ancoraM7('cnpj', 'CHASSI', true, false, 'MAIS_PRIME')
        .catch((e: unknown) => e)) as {
        getStatus(): number;
        getResponse(): Record<string, unknown>;
      };

      expect(erro.getStatus()).toBe(400);
      expect(erro.getResponse()).toEqual({
        statusCode: 400,
        message: 'Não foi possível atualizar a âncora do veículo.',
        error: 'Bad Request',
        code: 'RASTREAMENTO_COMANDO_RECUSADO',
      });
      expect(JSON.stringify(erro.getResponse())).not.toContain('VENDOR');
    });
  });
});
