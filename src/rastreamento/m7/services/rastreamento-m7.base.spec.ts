import axios from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { M7AuthService } from 'src/rastreamento/m7/services/m7-auth.service';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * `renovarToken` exige a base: antes, sem ela, renovava o token da base
 * padrão do deploy.
 */
describe('RastreamentoM7.renovarToken (base obrigatória)', () => {
  const envOriginal = { ...process.env };
  let m7: RastreamentoM7;
  let axiosPost: jest.SpyInstance;

  beforeEach(() => {
    process.env.M7_API_BASE_URL = 'https://m7.teste.local/';
    process.env.MO7_TOKEN = 'token-mp';
    process.env.M07_CODIGO = 'codigo-mp';
    process.env.MO7_TOKEN_RS = 'token-rs';
    process.env.M07_CODIGO_RS = 'codigo-rs';

    // A sessão saiu do client: quem autentica é o `M7AuthService`.
    m7 = new RastreamentoM7(
      new M7AuthService(
        new TenantCredentialsRegistry(),
        VendorSessionStore.emMemoria(),
      ),
    );
    axiosPost = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { sucesso: true, token: 'jwt-m7', expires_in: 3600 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...envOriginal };
  });

  it.each([
    ['ausente', undefined],
    ['vazia', ''],
    ['de outro deploy', 'OUTRA_EMPRESA'],
  ])(
    'base %s → BaseNaoResolvidaError e nenhum login na M7',
    async (_caso, base) => {
      await expect(m7.renovarToken(base as string)).rejects.toBeInstanceOf(
        BaseNaoResolvidaError,
      );
      expect(axiosPost).not.toHaveBeenCalled();
    },
  );

  it('renova com a credencial da base informada', async () => {
    await expect(m7.renovarToken('MAIS_PRIME_RS')).resolves.toEqual({
      token: 'jwt-m7',
      expires_in: 3600,
    });

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost).toHaveBeenCalledWith(
      'https://m7.teste.local/login',
      { codigo: 'codigo-rs', api_m7_token: 'token-rs' },
      expect.anything(),
    );
  });
});
