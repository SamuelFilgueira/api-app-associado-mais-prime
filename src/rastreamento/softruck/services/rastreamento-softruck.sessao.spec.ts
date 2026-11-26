import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { TokenResolverService } from 'src/shared/token-resolver.service';

/** JWT de mentira (sem assinatura válida) com o `exp` informado. */
function jwt(expiraEmSeg: number, marca: string): string {
  const parte = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${parte({ alg: 'none' })}.${parte({ exp: expiraEmSeg, marca })}.x`;
}

interface Interno {
  axiosInstance: { post: jest.Mock };
  autenticarSoftruck(base: string, chave: string): Promise<void>;
  softruckTokenByBase: Map<string, { token: string; expiresAt: number }>;
}

/**
 * O JWT da Softruck passa a ser compartilhado entre os processos: duas
 * instâncias com o mesmo store simulam duas réplicas.
 */
describe('RastreamentoSoftruck — sessão compartilhada entre réplicas', () => {
  const envOriginal = { ...process.env };
  const daquiAUmaHora = Math.floor(Date.now() / 1000) + 3600;
  let store: VendorSessionStore;
  let logins: number;

  const criar = (): Interno => {
    const servico = new RastreamentoSoftruck(
      {
        getTokenKey: (_base: string, tipo: string) =>
          tipo === 'softruckUsername'
            ? 'USERNAME_SOFTRUCK'
            : 'PASSWORD_SOFTRUCK',
      } as unknown as TokenResolverService,
      {} as M7ReverseGeocodeService,
      store,
    ) as unknown as Interno;
    servico.axiosInstance = {
      post: jest.fn(() => {
        logins += 1;
        return Promise.resolve({
          data: { data: { token: jwt(daquiAUmaHora, `login-${logins}`) } },
        });
      }),
    };
    return servico;
  };

  beforeEach(() => {
    process.env.USERNAME_SOFTRUCK = 'usuario';
    process.env.PASSWORD_SOFTRUCK = 'senha';
    process.env.SOFTRUCK_API_BASE_URL = 'https://softruck.teste';
    store = VendorSessionStore.emMemoria();
    logins = 0;
  });

  afterEach(() => {
    process.env = { ...envOriginal };
  });

  it('a segunda réplica adota o JWT da primeira, sem novo login', async () => {
    const a = criar();
    const b = criar();

    await a.autenticarSoftruck('MAIS_PRIME', 'chave-publica');
    await b.autenticarSoftruck('MAIS_PRIME', 'chave-publica');

    expect(logins).toBe(1);
    expect(b.softruckTokenByBase.get('MAIS_PRIME')?.token).toBe(
      a.softruckTokenByBase.get('MAIS_PRIME')?.token,
    );
  });

  it('o JWT guardado é o mesmo que a réplica já tem (foi recusado): faz login', async () => {
    const a = criar();
    await a.autenticarSoftruck('MAIS_PRIME', 'chave-publica');

    await a.autenticarSoftruck('MAIS_PRIME', 'chave-publica');

    expect(logins).toBe(2);
  });

  it('JWT guardado já vencido não é adotado', async () => {
    await store.gravar(
      'softruck',
      'token:MAIS_PRIME',
      jwt(Math.floor(Date.now() / 1000) - 10, 'vencido'),
      60,
    );
    const b = criar();

    await b.autenticarSoftruck('MAIS_PRIME', 'chave-publica');

    expect(logins).toBe(1);
  });

  it('a sessão é por base', async () => {
    const a = criar();
    await a.autenticarSoftruck('MAIS_PRIME', 'chave-publica');
    const b = criar();

    await b.autenticarSoftruck('MAIS_PRIME_RS', 'chave-publica');

    expect(logins).toBe(2);
  });
});
