import { Expo } from 'expo-server-sdk';
import {
  EXPO_PRAZO_MS,
  ExpoPushClient,
} from 'src/integrations/expo/expo-push.client';
import { MensagemPush, tokenMorto } from 'src/integrations/expo/push.gateway';

const tokenDe = (i: number) =>
  `ExponentPushToken[${String(i).padStart(22, '0')}]`;
const mensagens = (total: number): MensagemPush[] =>
  Array.from({ length: total }, (_, i) => ({ to: tokenDe(i), title: 't' }));

describe('ExpoPushClient', () => {
  let client: ExpoPushClient;
  let enviar: jest.SpyInstance;

  beforeEach(() => {
    client = new ExpoPushClient();
    enviar = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('250 mensagens: três lotes e um resultado por mensagem, na ordem de entrada', async () => {
    enviar.mockImplementation((lote: Array<{ to: string }>) =>
      Promise.resolve(
        lote.map((m) => ({ status: 'ok', id: `ticket-de-${m.to}` })),
      ),
    );

    const resultados = await client.enviar(mensagens(250));

    expect(enviar).toHaveBeenCalledTimes(3);
    expect(resultados).toHaveLength(250);
    resultados.forEach((resultado, i) => {
      expect(resultado).toEqual({
        status: 'ok',
        ticketId: `ticket-de-${tokenDe(i)}`,
      });
    });
  });

  it('lote do meio falha: só as mensagens dele voltam como falha de transporte', async () => {
    enviar
      .mockImplementationOnce((lote: unknown[]) =>
        Promise.resolve(lote.map(() => ({ status: 'ok', id: 'a' }))),
      )
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockImplementationOnce((lote: unknown[]) =>
        Promise.resolve(lote.map(() => ({ status: 'ok', id: 'c' }))),
      );

    const resultados = await client.enviar(mensagens(250));

    expect(resultados.slice(0, 100).every((r) => r.status === 'ok')).toBe(true);
    expect(
      resultados.slice(100, 200).every((r) => r.status === 'falha_transporte'),
    ).toBe(true);
    expect(resultados.slice(200).every((r) => r.status === 'ok')).toBe(true);
  });

  it('ticket de erro vira `recusado`, e DeviceNotRegistered identifica token morto', async () => {
    enviar.mockResolvedValue([
      { status: 'ok', id: 'a' },
      {
        status: 'error',
        message: 'não registrado',
        details: { error: 'DeviceNotRegistered' },
      },
      { status: 'error', message: 'corpo grande demais' },
    ]);

    const [ok, morto, recusado] = await client.enviar(mensagens(3));

    expect(ok.status).toBe('ok');
    expect(morto).toMatchObject({
      status: 'recusado',
      detalhe: 'DeviceNotRegistered',
    });
    expect(tokenMorto(morto)).toBe(true);
    expect(tokenMorto(recusado)).toBe(false);
    expect(tokenMorto(ok)).toBe(false);
  });

  it('Expo pendurado: desiste no prazo em vez de segurar o job', async () => {
    jest.useFakeTimers();
    enviar.mockReturnValue(new Promise(() => undefined));

    const promessa = client.enviar(mensagens(2));
    await jest.advanceTimersByTimeAsync(EXPO_PRAZO_MS + 10);
    const resultados = await promessa;

    expect(resultados).toEqual([
      expect.objectContaining({ status: 'falha_transporte' }),
      expect.objectContaining({ status: 'falha_transporte' }),
    ]);
  });

  it('consultarRecibos traduz ok e erro', async () => {
    jest
      .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
      .mockResolvedValue({
        a: { status: 'ok' },
        b: {
          status: 'error',
          message: 'x',
          details: { error: 'DeviceNotRegistered' },
        },
      } as never);

    const recibos = await client.consultarRecibos(['a', 'b']);

    expect(recibos.a).toEqual({ status: 'ok' });
    expect(tokenMorto(recibos.b)).toBe(true);
  });

  it('tokenValido reconhece o formato do Expo', () => {
    expect(client.tokenValido(tokenDe(1))).toBe(true);
    expect(client.tokenValido('abc')).toBe(false);
    expect(client.tokenValido(null)).toBe(false);
  });
});
