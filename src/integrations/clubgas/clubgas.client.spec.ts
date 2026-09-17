import axios from 'axios';
import { ClubgasClient } from './clubgas.client';
import { TokenResolverService } from '../../shared/token-resolver.service';

jest.mock('axios');
const axiosGet = jest.spyOn(axios, 'get');

/**
 * Cobre o modo de teste da homologação ClubGas (placa/CPF fixos por env):
 * - sem envs → URLs usam os dados do usuário (Mais Prime, produção)
 * - com envs → URLs usam os valores de teste nos três endpoints
 */
describe('ClubgasClient — modo de teste por env', () => {
  const envOriginal = { ...process.env };
  const tokenResolver = {
    resolveClubgasToken: jest.fn().mockReturnValue('token-base'),
  } as unknown as TokenResolverService;

  const urlChamada = (): string => axiosGet.mock.calls[0][0];

  beforeEach(() => {
    jest.clearAllMocks();
    axiosGet.mockResolvedValue({ data: { result: [] } });
    delete process.env.CLUBGAS_BASE_URL;
    delete process.env.CLUBGAS_TEST_PLACA;
    delete process.env.CLUBGAS_TEST_CPF;
    process.env.TOKEN_API_CLUBGAS = 'token-legado';
  });

  afterAll(() => {
    process.env = envOriginal;
  });

  it('sem envs usa a base de produção e os dados do usuário', async () => {
    const client = new ClubgasClient(tokenResolver);

    await client.obterPostosMapa('MAIS_PRIME', {
      latitude: -8.05,
      longitude: -34.9,
      placa: 'ABC1D23',
    });
    expect(urlChamada()).toBe(
      'https://clubgas-api.azurewebsites.net/api/v1/Posto/obter-map-app?Latitude=-8.05&Longitude=-34.9&Placa=ABC1D23',
    );

    axiosGet.mockClear();
    await client.obterCartaoVirtual('MAIS_PRIME', {
      placa: 'ABC1D23',
      cpf: '11122233344',
    });
    expect(urlChamada()).toContain('Placa=ABC1D23&Cpf=11122233344');

    axiosGet.mockClear();
    await client.obterTotalEconomizadoLegado('11122233344');
    expect(urlChamada()).toContain('CpfCnpj=11122233344');
    expect(axiosGet.mock.calls[0][1]).toEqual({
      headers: { Authorization: 'Bearer token-legado' },
    });
  });

  it('com envs substitui placa e CPF nos três endpoints, mantendo lat/long', async () => {
    process.env.CLUBGAS_BASE_URL =
      'https://tst-clubgas-api.azurewebsites.net/api/v1/';
    process.env.CLUBGAS_TEST_PLACA = 'SEL0C00';
    process.env.CLUBGAS_TEST_CPF = '04806375128';
    const client = new ClubgasClient(tokenResolver);

    await client.obterPostosMapa('HERTZ', {
      latitude: -16.6945,
      longitude: -49.3323,
      placa: 'PLACAREAL',
    });
    expect(urlChamada()).toBe(
      'https://tst-clubgas-api.azurewebsites.net/api/v1/Posto/obter-map-app?Latitude=-16.6945&Longitude=-49.3323&Placa=SEL0C00',
    );

    axiosGet.mockClear();
    await client.obterCartaoVirtual('HERTZ', {
      placa: 'PLACAREAL',
      cpf: '99999999999',
    });
    expect(urlChamada()).toBe(
      'https://tst-clubgas-api.azurewebsites.net/api/v1/CartaoClub/obter-virtual?Placa=SEL0C00&Cpf=04806375128',
    );

    axiosGet.mockClear();
    await client.obterTotalEconomizadoLegado('99999999999');
    expect(urlChamada()).toBe(
      'https://tst-clubgas-api.azurewebsites.net/api/v1/Aplicativo/total-economizado?CpfCnpj=04806375128',
    );
  });

  it('só a placa definida substitui só a placa', async () => {
    process.env.CLUBGAS_TEST_PLACA = 'SEL0C00';
    const client = new ClubgasClient(tokenResolver);
    await client.obterCartaoVirtual('HERTZ', {
      placa: 'PLACAREAL',
      cpf: '99999999999',
    });
    expect(urlChamada()).toContain('Placa=SEL0C00&Cpf=99999999999');
  });
});
