import { Queue } from 'bullmq';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';

/**
 * Destino e formato dos pushes em lote do Associado da Sorte: fila de MASSA,
 * em jobs de até 100 mensagens. (A fila injetada no service é a
 * `PUSH_MASSA_QUEUE`; a de alerta fica só com ignição, âncora e avulsos.)
 */
describe('SorteNotificacoesService — pushes em lote na fila de massa', () => {
  const token = (n: number) => `ExponentPushToken[u${n}]`;

  function montar() {
    const ganhadores = { listarParaPush: jest.fn() };
    const rodadas = {
      listarParaLembrar: jest.fn().mockResolvedValue([]),
      reivindicarLembrete: jest.fn().mockResolvedValue(true),
      listarDestinatariosDoLembrete: jest.fn().mockResolvedValue([]),
    };
    const notifications = {
      sendPushNotification: jest.fn().mockResolvedValue({ success: true }),
    };
    const filaDeMassa = { addBulk: jest.fn().mockResolvedValue(undefined) };
    const service = new SorteNotificacoesService(
      ganhadores as unknown as SorteGanhadoresRepository,
      rodadas as unknown as SorteRodadasRepository,
      notifications as unknown as NotificationsService,
      filaDeMassa as unknown as Queue,
    );
    return { service, ganhadores, rodadas, notifications, filaDeMassa };
  }

  const jobsDe = (fila: { addBulk: jest.Mock }) =>
    fila.addBulk.mock.calls.flatMap((c) => c[0]) as Array<{
      name: string;
      data: {
        mensagens: Array<{ userId: number; title: string; body: string }>;
        baseOrigin?: string;
        _meta?: unknown;
      };
      opts?: unknown;
    }>;

  it('lembrete de rodada ("avise-me"): 250 destinatários viram três jobs `sorte-lembrete` de até 100 mensagens', async () => {
    const { service, rodadas, filaDeMassa, notifications } = montar();
    const agora = new Date('2026-11-20T12:00:00.000Z');
    rodadas.listarParaLembrar.mockResolvedValue([
      {
        id: 4,
        titulo: 'Rodada relâmpago',
        abertura: new Date(agora.getTime() + 10 * 60_000),
        premio: { nome: 'Vale-compra' },
      },
    ]);
    rodadas.listarDestinatariosDoLembrete.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => ({
        user: { id: i + 1, expoPushToken: token(i + 1) },
      })),
    );

    expect(await service.enviarLembretes(agora)).toBe(250);

    const jobs = jobsDe(filaDeMassa);
    expect(jobs.map((j) => j.name)).toEqual([
      'sorte-lembrete',
      'sorte-lembrete',
      'sorte-lembrete',
    ]);
    expect(jobs.map((j) => j.data.mensagens.length)).toEqual([100, 100, 50]);
    expect(jobs[0].data.mensagens[0]).toEqual({
      userId: 1,
      expoPushToken: token(1),
      title: 'Está quase na hora ⏰',
      body: '"Rodada relâmpago" abre em 10 min no Associado da Sorte. Prepare-se!',
      data: {
        type: 'internal_route',
        screen: 'associado-da-sorte/rodada/4',
      },
    });
    expect(jobs[0].data._meta).toBeDefined();
    // Sem opções no job: vale o retry padrão da fila de massa.
    expect(jobs.every((j) => j.opts === undefined)).toBe(true);
    expect(notifications.sendPushNotification).not.toHaveBeenCalled();
  });

  it('vários ganhadores (apuração): um job `sorte-ganhador` por base, com a mensagem de cada um', async () => {
    const { service, ganhadores, filaDeMassa, notifications } = montar();
    ganhadores.listarParaPush.mockResolvedValue([
      {
        id: 11,
        userId: 1,
        baseOrigin: 'MAIS_PRIME',
        origem: 'SORTEIO',
        premio: { nome: 'TV' },
        user: { expoPushToken: token(1) },
      },
      {
        id: 12,
        userId: 2,
        baseOrigin: 'MAIS_PRIME_RS',
        origem: 'LOJA',
        premio: { nome: 'Caneca' },
        user: { expoPushToken: token(2) },
      },
      {
        id: 13,
        userId: 3,
        baseOrigin: 'MAIS_PRIME',
        origem: 'SORTEIO',
        premio: { nome: 'TV' },
        user: { expoPushToken: null },
      },
    ]);

    await service.avisarGanhadores([11, 12, 13]);

    const jobs = jobsDe(filaDeMassa);
    expect(jobs.map((j) => [j.name, j.data.baseOrigin])).toEqual([
      ['sorte-ganhador', 'MAIS_PRIME'],
      ['sorte-ganhador', 'MAIS_PRIME_RS'],
    ]);
    expect(jobs[0].data.mensagens).toEqual([
      {
        userId: 1,
        expoPushToken: token(1),
        title: 'Você ganhou! 🎉',
        body: 'Você levou "TV" no Associado da Sorte. Toque para ver como receber.',
        data: {
          type: 'internal_route',
          screen: 'associado-da-sorte/premio/11',
        },
      },
    ]);
    expect(jobs[1].data.mensagens[0]).toMatchObject({
      userId: 2,
      title: 'Pedido confirmado 🎁',
    });
    expect(notifications.sendPushNotification).not.toHaveBeenCalled();
  });

  it('um ganhador só: envio direto, sem fila (como antes)', async () => {
    const { service, ganhadores, filaDeMassa, notifications } = montar();
    ganhadores.listarParaPush.mockResolvedValue([
      {
        id: 11,
        userId: 1,
        baseOrigin: 'MAIS_PRIME',
        origem: 'LOJA',
        premio: { nome: 'Caneca' },
        user: { expoPushToken: token(1) },
      },
    ]);

    await service.avisarGanhadores([11]);

    expect(notifications.sendPushNotification).toHaveBeenCalledWith(
      1,
      token(1),
      'Pedido confirmado 🎁',
      'Seu pedido "Caneca" na Loja da Sorte foi registrado. Toque para ver como retirar.',
      { type: 'internal_route', screen: 'associado-da-sorte/premio/11' },
    );
    expect(filaDeMassa.addBulk).not.toHaveBeenCalled();
  });
});
