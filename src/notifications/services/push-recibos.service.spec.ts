import {
  CenarioDePushEmMassa,
  montarCenarioDePushEmMassa,
  tokenDe,
} from 'src/notifications/testing/cenario-push-massa';
import { PUSH_MASSA_QUEUE } from 'src/queue/filas';

/**
 * Recibos: o ticket diz que o Expo aceitou; o recibo, minutos depois, diz se
 * o aparelho recebeu.
 */
describe('PushRecibosService', () => {
  let cenario: CenarioDePushEmMassa;

  const disparoEnviado = async (usuarios: number) => {
    cenario = montarCenarioDePushEmMassa();
    cenario.repo.comUsuarios(usuarios, tokenDe);
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    await cenario.executarLotes();
  };
  const estadosPorUsuario = () =>
    Object.fromEntries(
      cenario.repo.entregasDo(1).map((e) => [e.userId, e.estado]),
    );
  const recibosAgendados = () =>
    cenario.produtor.da(PUSH_MASSA_QUEUE, 'push-recibos');

  it('marca ENTREGUE ou RECUSADA pelo recibo; o que ainda não tem recibo segue ENVIADA', async () => {
    await disparoEnviado(4);
    cenario.gateway.recibos = (ids) => ({
      [ids[0]]: { status: 'ok' },
      [ids[1]]: {
        status: 'erro',
        mensagem: 'não registrado',
        detalhe: 'DeviceNotRegistered',
      },
      [ids[2]]: {
        status: 'erro',
        mensagem: 'limite',
        detalhe: 'MessageRateExceeded',
      },
      // ids[3]: o Expo ainda não tem o recibo.
    });

    const r = await cenario.recibos.processar({ disparoId: 1, passada: 1 });

    expect(r).toEqual({ entregues: 1, recusadas: 2, semRecibo: 1 });
    expect(cenario.gateway.consultas).toEqual([
      [1, 2, 3, 4].map((id) => `ticket-${tokenDe(id)}`),
    ]);
    expect(estadosPorUsuario()).toEqual({
      1: 'ENTREGUE',
      2: 'RECUSADA',
      3: 'RECUSADA',
      4: 'ENVIADA',
    });
    expect(cenario.repo.entregasDo(1)[1]).toMatchObject({
      erro: 'DeviceNotRegistered: não registrado',
      reciboEm: expect.any(Date),
    });
  });

  it('recibo de token morto apaga o token; token trocado no meio fica', async () => {
    await disparoEnviado(2);
    const tokenNovo = 'ExponentPushToken[novo-do-2]';
    cenario.repo.usuarios.get(2)!.expoPushToken = tokenNovo;
    cenario.gateway.recibos = (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            status: 'erro' as const,
            mensagem: 'x',
            detalhe: 'DeviceNotRegistered',
          },
        ]),
      );

    await cenario.recibos.processar({ disparoId: 1, passada: 1 });

    expect(cenario.repo.usuarios.get(1)!.expoPushToken).toBeNull();
    expect(cenario.repo.usuarios.get(2)!.expoPushToken).toBe(tokenNovo);
  });

  it('faltou recibo: agenda nova passada mais tarde, até o limite', async () => {
    await disparoEnviado(2);
    cenario.gateway.recibos = () => ({});

    await cenario.recibos.processar({ disparoId: 1, passada: 1 });
    await cenario.recibos.processar({ disparoId: 1, passada: 2 });
    await cenario.recibos.processar({ disparoId: 1, passada: 3 });

    expect(recibosAgendados().map((j) => [j.id, j.opcoes.atrasoMs])).toEqual([
      ['push-recibos-1-1', 15 * 60_000],
      ['push-recibos-1-2', 30 * 60_000],
      ['push-recibos-1-3', 60 * 60_000],
    ]);
  });

  it('todos com recibo: não agenda outra passada; reexecução não consulta de novo', async () => {
    await disparoEnviado(3);

    await cenario.recibos.processar({ disparoId: 1, passada: 1 });
    const r = await cenario.recibos.processar({ disparoId: 1, passada: 1 });

    expect(r).toEqual({ entregues: 0, recusadas: 0, semRecibo: 0 });
    expect(cenario.gateway.consultas).toHaveLength(1);
    expect(recibosAgendados()).toHaveLength(1);
  });

  it('provedor fora na consulta: lança (o job repete) e nada é marcado', async () => {
    await disparoEnviado(2);
    cenario.gateway.recibos = () => {
      throw new Error('socket hang up');
    };

    await expect(
      cenario.recibos.processar({ disparoId: 1, passada: 1 }),
    ).rejects.toThrow('socket hang up');
    expect(estadosPorUsuario()).toEqual({ 1: 'ENVIADA', 2: 'ENVIADA' });
  });
});
