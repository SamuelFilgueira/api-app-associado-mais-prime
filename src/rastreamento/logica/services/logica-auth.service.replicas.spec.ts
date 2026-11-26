import axios from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { LogicaAuthService } from 'src/rastreamento/logica/services/logica-auth.service';

jest.mock('axios');
const axiosPost = jest.spyOn(axios, 'post');

/**
 * A Lógica autentica com uma credencial só e cada login novo compete com a
 * sessão anterior. Duas instâncias com o mesmo store simulam duas réplicas.
 */
describe('LogicaAuthService — sessão compartilhada entre réplicas', () => {
  let store: VendorSessionStore;
  let a: LogicaAuthService;
  let b: LogicaAuthService;
  const envOriginal = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOGICA_API_NUMBER = '123';
    process.env.LOGICA_API_BASE_URL = 'https://logica.teste';
    let n = 0;
    axiosPost.mockImplementation(() =>
      Promise.resolve({
        data: { erro: false, logado: true, token: `t${++n}` },
      }),
    );
    store = VendorSessionStore.emMemoria();
    a = new LogicaAuthService(store);
    b = new LogicaAuthService(store);
  });

  afterEach(() => {
    process.env = { ...envOriginal };
  });

  it('a réplica B usa o token que a réplica A renovou, sem novo login', async () => {
    await expect(a.renovarToken('MAIS_PRIME', 'token-env')).resolves.toBe('t1');

    await expect(b.obterTokenInicial('MAIS_PRIME', 'token-env')).resolves.toBe(
      't1',
    );
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('B teve o token antigo recusado depois de A renovar: adota o de A', async () => {
    await a.renovarToken('MAIS_PRIME', 'token-antigo');

    await expect(b.renovarToken('MAIS_PRIME', 'token-antigo')).resolves.toBe(
      't1',
    );
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('o token guardado é o que foi recusado: aí sim faz login', async () => {
    await a.renovarToken('MAIS_PRIME', 'token-antigo');

    await expect(b.renovarToken('MAIS_PRIME', 't1')).resolves.toBe('t2');
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  it('sem informar o token recusado, mantém o comportamento antigo (login)', async () => {
    await a.renovarToken('MAIS_PRIME');
    await b.renovarToken('MAIS_PRIME');

    expect(axiosPost).toHaveBeenCalledTimes(2);
  });
});
