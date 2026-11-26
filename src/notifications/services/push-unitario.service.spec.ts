import { Job } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import {
  NotificationJobData,
  NotificationProcessor,
} from 'src/notifications/processors/notification.processor';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { PushUnitarioService } from 'src/notifications/services/push-unitario.service';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { IntegrationError, ehErroTransitorio } from 'src/shared/erros/erros';

/**
 * Push para um usuário e o job da fila de alerta que o envia.
 *
 * Antes: o erro do Expo virava `{ success: false }` e o job concluía (sem
 * retry), e a linha da caixa de entrada era gravada ANTES do envio (job
 * repetido gravava de novo).
 */
describe('push unitário (fila de alerta)', () => {
  const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
  const pedido = {
    userId: 5,
    expoPushToken: TOKEN,
    title: 'Ignição Ligada',
    body: 'Corpo',
    data: { ignition: 'on' },
  };

  function montar() {
    const usuario = {
      id: 5,
      notificacaoIgnicao: true,
      expoPushToken: TOKEN as string | null,
    };
    const linhas: Array<{ id: number; userId: number }> = [];
    const prisma = {
      user: {
        findUnique: jest.fn(() => Promise.resolve(usuario)),
        // `UPDATE ... WHERE id = ? AND expoPushToken = ?`
        updateMany: jest.fn(
          ({ where }: { where: { id: number; expoPushToken: string } }) => {
            const casa =
              where.id === usuario.id &&
              usuario.expoPushToken === where.expoPushToken;
            if (casa) usuario.expoPushToken = null;
            return Promise.resolve({ count: casa ? 1 : 0 });
          },
        ),
      },
      notification: {
        create: jest.fn(({ data }: { data: { userId: number } }) => {
          const linha = { id: linhas.length + 1, userId: data.userId };
          linhas.push(linha);
          return Promise.resolve(linha);
        }),
      },
    };
    const banco = prisma as unknown as PrismaService;
    const gateway = new PushGatewayFalso();
    const tokens = new PushTokenService(banco, gateway);
    const caixa = new CaixaDeEntradaService(banco);
    const service = new PushUnitarioService(banco, gateway, caixa, tokens);
    const processor = new NotificationProcessor(service, {
      receber: jest.fn(),
    } as unknown as FilaDeMortosService);

    /** Job do BullMQ: `updateData` grava no próprio job, como no Redis. */
    const criarJob = (nome = 'alerta-veiculo') => {
      const job = {
        id: '1',
        name: nome,
        queueName: 'notifications',
        attemptsMade: 0,
        data: { ...pedido } as NotificationJobData,
        updateData: jest.fn((dados: NotificationJobData) => {
          job.data = dados;
          return Promise.resolve();
        }),
      };
      return job;
    };
    const processar = (job: ReturnType<typeof criarJob>) =>
      processor.process(job as unknown as Job<NotificationJobData>);

    return { service, gateway, prisma, usuario, linhas, criarJob, processar };
  }

  describe('PushUnitarioService.enviar', () => {
    it('aceito: grava a caixa de entrada DEPOIS do envio', async () => {
      const { service, gateway, prisma } = montar();
      const ordem: string[] = [];
      gateway.responder = (mensagens) => {
        ordem.push('push');
        return PushGatewayFalso.aceitarTudo(mensagens);
      };
      prisma.notification.create.mockImplementation(() => {
        ordem.push('caixa');
        return Promise.resolve({ id: 1, userId: 5 });
      });

      await expect(service.enviar(pedido)).resolves.toEqual({
        status: 'enviado',
        notificationId: 1,
      });
      expect(ordem).toEqual(['push', 'caixa']);
    });

    it('recusa do Expo: não lança e o aviso continua indo para a caixa de entrada (o sino não depende do push)', async () => {
      const { service, gateway, linhas } = montar();
      gateway.responder = () => [
        { status: 'recusado', mensagem: 'grande', detalhe: 'MessageTooBig' },
      ];

      await expect(service.enviar(pedido)).resolves.toEqual({
        status: 'recusado',
        mensagem: 'grande',
        notificationId: expect.any(Number),
      });
      expect(linhas).toHaveLength(1);
    });

    it('falha de transporte dentro de um job: devolve o status e NÃO grava (o job repete; a linha sai na tentativa com desfecho)', async () => {
      const { service, gateway, linhas } = montar();
      gateway.responder = PushGatewayFalso.semResposta;
      const memoria = {
        pushAceito: false,
        marcarPushAceito: jest.fn().mockResolvedValue(undefined),
      };

      await expect(service.enviar(pedido, memoria)).resolves.toEqual({
        status: 'falha_transporte',
        mensagem: 'socket hang up',
      });
      expect(linhas).toHaveLength(0);
      expect(memoria.marcarPushAceito).not.toHaveBeenCalled();
    });

    it('falha de transporte em chamada direta: não há nova tentativa, então a caixa de entrada registra o aviso', async () => {
      const { service, gateway, linhas } = montar();
      gateway.responder = PushGatewayFalso.semResposta;

      await expect(service.enviar(pedido)).resolves.toEqual({
        status: 'falha_transporte',
        mensagem: 'socket hang up',
        notificationId: expect.any(Number),
      });
      expect(linhas).toHaveLength(1);
    });

    it('token morto (`DeviceNotRegistered`) é apagado do usuário', async () => {
      const { service, gateway, usuario } = montar();
      gateway.responder = () => [
        {
          status: 'recusado',
          mensagem: 'não registrado',
          detalhe: 'DeviceNotRegistered',
        },
      ];

      await service.enviar(pedido);

      expect(usuario.expoPushToken).toBeNull();
    });

    it('token trocado no meio do caminho não é apagado', async () => {
      const { service, gateway, usuario, prisma } = montar();
      // O usuário reinstalou o app: o job ainda carrega o token antigo.
      usuario.expoPushToken = 'ExponentPushToken[novo]';
      gateway.responder = () => [
        {
          status: 'recusado',
          mensagem: 'não registrado',
          detalhe: 'DeviceNotRegistered',
        },
      ];

      await service.enviar(pedido);

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 5, expoPushToken: TOKEN },
        data: { expoPushToken: null },
      });
      expect(usuario.expoPushToken).toBe('ExponentPushToken[novo]');
    });

    it('recusa por outro motivo não mexe no token', async () => {
      const { service, gateway, prisma } = montar();
      gateway.responder = () => [
        { status: 'recusado', mensagem: 'x', detalhe: 'MessageRateExceeded' },
      ];

      await service.enviar(pedido);

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('NotificationProcessor', () => {
    it('falha de transporte faz o job FALHAR com erro transitório (o BullMQ repete)', async () => {
      const { gateway, criarJob, processar, linhas } = montar();
      gateway.responder = PushGatewayFalso.semResposta;

      const erro = await processar(criarJob()).catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(IntegrationError);
      expect(ehErroTransitorio(erro)).toBe(true);
      expect(linhas).toHaveLength(0);
    });

    it('nova tentativa depois da falha de transporte: UM push aceito e UMA linha', async () => {
      const { gateway, criarJob, processar, linhas } = montar();
      const job = criarJob();
      gateway.responder = PushGatewayFalso.semResposta;
      await processar(job).catch(() => undefined);
      gateway.responder = PushGatewayFalso.aceitarTudo;

      await expect(processar(job)).resolves.toEqual({
        success: true,
        message: 'Notificação enviada com sucesso.',
        notificationId: 1,
      });
      expect(gateway.aceitosPorToken().get(TOKEN)).toBe(1);
      expect(linhas).toHaveLength(1);
    });

    it('recusa do Expo NÃO faz o job falhar: conclui com `success: false`', async () => {
      const { gateway, criarJob, processar } = montar();
      gateway.responder = () => [
        { status: 'recusado', mensagem: 'grande', detalhe: 'MessageTooBig' },
      ];

      await expect(processar(criarJob())).resolves.toEqual({
        success: false,
        message: 'grande',
        notificationId: expect.any(Number),
      });
    });

    it('banco falha depois de o push ser aceito: a nova tentativa só grava a caixa, sem mandar o push de novo', async () => {
      const { gateway, criarJob, processar, prisma, linhas } = montar();
      const job = criarJob();
      prisma.notification.create.mockRejectedValueOnce(
        new Error('ECONNRESET: banco fora'),
      );

      await expect(processar(job)).rejects.toThrow('banco fora');
      expect(job.data._pushAceito).toBe(true);

      await expect(processar(job)).resolves.toMatchObject({ success: true });
      expect(gateway.totalDeMensagens()).toBe(1);
      expect(linhas).toHaveLength(1);
    });

    it('atende os jobs `sorte-*` que já estavam na fila de alerta antes do deploy (formato antigo)', async () => {
      const { gateway, criarJob, processar, linhas } = montar();

      await expect(
        processar(criarJob('sorte-lembrete-raspada')),
      ).resolves.toMatchObject({ success: true });
      expect(gateway.chamadas[0][0].to).toBe(TOKEN);
      expect(linhas).toHaveLength(1);
    });
  });
});
