import { CacheService } from 'src/infra/cache/cache.service';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';

describe('HinovaClient — leituras com cache', () => {
  let redis: RedisEmMemoria;
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let client: HinovaClient;

  const ok = (data: unknown) => ({ status: 200, statusText: 'OK', data });
  const filtro = {
    codigo_veiculo: 55,
    data_vencimento_original_inicial: '01/10/2026',
    data_vencimento_original_final: '31/12/2026',
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-25T12:00:00Z') });
    redis = new RedisEmMemoria();
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    client = new HinovaClient(
      sgaAuth as unknown as SgaAuthService,
      new CacheService(redis.comoRedis()),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.HINOVA_CACHE_ASSOCIADO_SEG;
    delete process.env.HINOVA_CACHE_ANTIGO_SEG;
  });

  it('associado: a segunda leitura não vai à Hinova e a chave começa pela base', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok({ nome: 'Fulano' }));

    const primeira = await client.buscarAssociado(
      'MAIS_PRIME',
      '529.982.247-25',
    );
    const segunda = await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(primeira).toMatchObject({ status: 200, fonte: 'origem' });
    expect(segunda).toMatchObject({
      status: 200,
      data: { nome: 'Fulano' },
      fonte: 'cache',
    });
    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
    expect(redis.chaves()).toEqual(['MAIS_PRIME:sga:associado:52998224725']);
  });

  it('o cache de uma base não atende outra', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok({ nome: 'Fulano' }));

    await client.buscarAssociado('MAIS_PRIME', '52998224725');
    await client.buscarAssociado('MAIS_PRIME_RS', '52998224725');

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
    expect(sgaAuth.executeRequestWithAuth.mock.calls.map((c) => c[0])).toEqual([
      'MAIS_PRIME',
      'MAIS_PRIME_RS',
    ]);
  });

  it('passados os 5 minutos, consulta de novo', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok({ nome: 'Fulano' }));
    await client.buscarAssociado('MAIS_PRIME', '52998224725');

    jest.advanceTimersByTime(6 * 60_000);
    await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'recusa de negócio (406)',
      { status: 406, statusText: '', data: { mensagem: 'Não aceitável' } },
    ],
    [
      'bloqueio do token (403)',
      { status: 403, statusText: '', data: { mensagem: 'Forbidden' } },
    ],
    ['erro do servidor (502)', { status: 502, statusText: '', data: '<html>' }],
    [
      '200 com HTML de proxy',
      { status: 200, statusText: 'OK', data: '<html>erro</html>' },
    ],
  ])('%s: volta como veio e NÃO é guardada', async (_caso, resposta) => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue(resposta);

    const lida = await client.buscarAssociado('MAIS_PRIME', '52998224725');
    await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(lida).toMatchObject({
      status: resposta.status,
      data: resposta.data,
    });
    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
    expect(redis.chaves()).toEqual([]);
  });

  it('invalidarAssociado força a próxima leitura a ir à Hinova', async () => {
    sgaAuth.executeRequestWithAuth
      .mockResolvedValueOnce(ok({ situacao: 'INADIMPLENTE' }))
      .mockResolvedValueOnce(ok({ situacao: 'ATIVO' }));
    await client.buscarAssociado('MAIS_PRIME', '52998224725');

    await client.invalidarAssociado('MAIS_PRIME', '529.982.247-25');
    const depois = await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(depois.data).toEqual({ situacao: 'ATIVO' });
  });

  it('Hinova fora depois do prazo: por padrão NÃO serve valor antigo', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValueOnce(
      ok({ nome: 'Fulano' }),
    );
    await client.buscarAssociado('MAIS_PRIME', '52998224725');
    jest.advanceTimersByTime(6 * 60_000);
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 503,
      statusText: '',
      data: 'fora',
    });

    const lida = await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(lida).toMatchObject({ status: 503, fonte: 'origem' });
  });

  it('com HINOVA_CACHE_ANTIGO_SEG, serve o valor vencido e informa de quando ele é', async () => {
    process.env.HINOVA_CACHE_ANTIGO_SEG = '3600';
    sgaAuth.executeRequestWithAuth.mockResolvedValueOnce(
      ok({ nome: 'Fulano' }),
    );
    await client.buscarAssociado('MAIS_PRIME', '52998224725');
    jest.advanceTimersByTime(10 * 60_000);
    sgaAuth.executeRequestWithAuth.mockRejectedValue(new Error('timeout'));

    const lida = await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(lida).toMatchObject({
      status: 200,
      data: { nome: 'Fulano' },
      fonte: 'antigo',
    });
    expect(lida.atualizadoEm.toISOString()).toBe('2026-11-25T12:00:00.000Z');
  });

  it('HINOVA_CACHE_ASSOCIADO_SEG=0 desliga o cache dessa leitura', async () => {
    process.env.HINOVA_CACHE_ASSOCIADO_SEG = '0';
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok({ nome: 'Fulano' }));

    await client.buscarAssociado('MAIS_PRIME', '52998224725');
    await client.buscarAssociado('MAIS_PRIME', '52998224725');

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
  });

  it('Redis fora: as leituras vão direto à Hinova, sem erro', async () => {
    redis.fora = true;
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok({ nome: 'Fulano' }));

    await expect(
      client.buscarAssociado('MAIS_PRIME', '52998224725'),
    ).resolves.toMatchObject({ status: 200, fonte: 'origem' });
  });

  it('boletos: chave por veículo e janela; invalidar apaga a janela informada', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok([{ nosso_numero: 1 }]));

    await client.listarBoletosDoVeiculo('MAIS_PRIME', filtro);
    await client.listarBoletosDoVeiculo('MAIS_PRIME', filtro);
    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
    expect(sgaAuth.executeRequestWithAuth.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      data: filtro,
    });

    await client.invalidarBoletos('MAIS_PRIME', filtro);
    await client.listarBoletosDoVeiculo('MAIS_PRIME', filtro);
    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
  });

  it('produtos do veículo ficam em cache por horas', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue(ok({ produtos: [] }));

    await client.listarProdutosDoVeiculo('MAIS_PRIME', '55');
    jest.advanceTimersByTime(5 * 3_600_000);
    await client.listarProdutosDoVeiculo('MAIS_PRIME', '55');

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
  });
});
