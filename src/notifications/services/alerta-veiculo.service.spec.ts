import { PrismaService } from 'src/database/prisma.service';
import { AlertaVeiculoService } from 'src/notifications/services/alerta-veiculo.service';
import { ProdutorFalso } from 'src/notifications/testing/filas.falsas';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { NOTIFICATION_QUEUE, PUSH_MASSA_QUEUE } from 'src/queue/filas';

/**
 * Alerta de veículo: a regra de quem recebe (que veio do god service) e o
 * destino do push — a fila de ALERTA, nunca a de massa.
 */
describe('AlertaVeiculoService', () => {
  const token = (n: number) => `ExponentPushToken[usuario-${n}]`;
  const vinculo = (
    userId: number,
    plate: string | null,
    doVeiculo: boolean | null,
    daConta: boolean,
  ) => ({
    userId,
    plate,
    notificacaoIgnicao: doVeiculo,
    user: { notificacaoIgnicao: daConta },
  });

  function montar() {
    const prisma = {
      userVehicle: {
        findMany: jest.fn().mockResolvedValue([
          // 1: alerta ligado neste veículo; 2: sem valor no veículo, segue a
          // conta (ligada); 3 e 4: ligados (o corte deles é o token).
          vinculo(1, 'ABC1D23', true, false),
          vinculo(2, null, null, true),
          vinculo(3, 'XYZ9K88', true, true),
          vinculo(4, 'QQQ0A00', null, true),
          // 5: desligou ESTE veículo, mas tem outro com alerta (conta ligada).
          vinculo(5, 'OFF0A00', false, true),
          // 6: sem valor no veículo e conta desligada.
          vinculo(6, 'OFF1A11', null, false),
        ]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, expoPushToken: token(1), baseOrigin: 'MAIS_PRIME' },
          { id: 2, expoPushToken: token(2), baseOrigin: 'MAIS_PRIME_RS' },
          // 3: token com formato inválido; 4: sem token (fora da consulta).
          { id: 3, expoPushToken: 'lixo', baseOrigin: 'MAIS_PRIME' },
        ]),
      },
    };
    const gateway = new PushGatewayFalso();
    const produtor = new ProdutorFalso();
    const service = new AlertaVeiculoService(
      prisma as unknown as PrismaService,
      gateway,
      produtor.comoProdutor(),
    );
    return { service, prisma, gateway, produtor };
  }

  it('ignição ligada: um job por usuário com token válido, na fila de alerta, com a base do usuário', async () => {
    const { service, prisma, produtor, gateway } = montar();

    const r = await service.dispararNotificacaoVeiculoWebhook(
      '9BW123',
      32,
      null,
    );

    expect(r).toEqual({ sent: 2, skipped: 2 });
    // O alerta é por veículo: quem desligou ESTE veículo (5) ou não tem
    // valor no veículo e está com a conta desligada (6) nem entra na busca.
    expect(prisma.userVehicle.findMany).toHaveBeenCalledWith({
      where: { chassi: '9BW123', isActive: true, user: { isActive: true } },
      select: {
        userId: true,
        plate: true,
        notificacaoIgnicao: true,
        user: { select: { notificacaoIgnicao: true } },
      },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [1, 2, 3, 4] },
        isActive: true,
        expoPushToken: { not: null },
      },
      select: { id: true, expoPushToken: true, baseOrigin: true },
    });
    expect(produtor.da(NOTIFICATION_QUEUE)).toEqual([
      expect.objectContaining({
        nome: 'alerta-veiculo',
        dados: {
          userId: 1,
          expoPushToken: token(1),
          title: 'Ignição Ligada 🔑',
          body: 'A ignição do seu veículo (placa ABC1D23) foi ligada.',
          data: {
            chassi: '9BW123',
            plate: 'ABC1D23',
            ignition: 'on',
            eventType: 'ignition_on',
          },
        },
        opcoes: { base: 'MAIS_PRIME', jobId: undefined },
      }),
      expect.objectContaining({
        dados: expect.objectContaining({
          userId: 2,
          body: 'A ignição do seu veículo (chassi 9BW123) foi ligada.',
        }),
        opcoes: { base: 'MAIS_PRIME_RS', jobId: undefined },
      }),
    ]);
    // O envio é do job: o webhook não espera o Expo, e nada vai para a massa.
    expect(gateway.chamadas).toHaveLength(0);
    expect(produtor.da(PUSH_MASSA_QUEUE)).toHaveLength(0);
  });

  it('violação de âncora: texto próprio, sem `ignition`', async () => {
    const { service, produtor } = montar();

    await service.dispararNotificacaoVeiculoWebhook(
      '9BW123',
      null,
      'Violação de Ancora',
    );

    expect(produtor.da(NOTIFICATION_QUEUE)[0].dados).toMatchObject({
      title: 'Violação de Âncora ⚠️',
      body: 'Violação de âncora detectada no seu veículo (placa ABC1D23).',
      data: { chassi: '9BW123', eventType: 'ancora_violation' },
    });
    expect(
      produtor.da(NOTIFICATION_QUEUE)[0].dados.data.ignition,
    ).toBeUndefined();
  });

  it('com a chave do evento, o mesmo webhook reprocessado não gera outro push', async () => {
    const { service, produtor } = montar();
    const opcoes = { chaveDoEvento: 'webhook-m7:8812' };

    await service.dispararNotificacaoVeiculoWebhook('9BW123', 32, null, opcoes);
    await service.dispararNotificacaoVeiculoWebhook('9BW123', 32, null, opcoes);

    expect(produtor.da(NOTIFICATION_QUEUE).map((j) => j.id)).toEqual([
      'alerta-webhook-m7_8812-1',
      'alerta-webhook-m7_8812-2',
    ]);
  });

  it('fila fora: o erro sobe para quem chamou (o alerta não é dado como enviado)', async () => {
    const { service, produtor } = montar();
    produtor.erro = new Error('Redis fora');

    await expect(
      service.dispararNotificacaoVeiculoWebhook('9BW123', 32, null),
    ).rejects.toThrow('Redis fora');
  });
});
