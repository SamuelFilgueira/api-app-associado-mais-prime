import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { AlertaVeiculoService } from 'src/notifications/services/alerta-veiculo.service';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { MarketingDisparoService } from 'src/notifications/services/marketing-disparo.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { PopupService } from 'src/notifications/services/popup.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { PushUnitarioService } from 'src/notifications/services/push-unitario.service';
import { ProdutorFalso } from 'src/notifications/testing/filas.falsas';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';

/**
 * Caracterização do `NotificationsService`, escrita ANTES da quebra do god
 * service: o que cada método público devolve e o que ele grava. Os casos
 * são os mesmos de antes da extração; mudou só a montagem (a fachada sobre
 * os casos de uso, com o provedor de push trocado pelo dublê da porta
 * `PushGateway` no lugar do `new Expo()` interno).
 */
describe('NotificationsService — caracterização', () => {
  const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

  function montar() {
    const prisma = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      userVehicle: { findMany: jest.fn().mockResolvedValue([]) },
      notification: {
        create: jest.fn().mockResolvedValue({ id: 77 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      notificationPopup: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    const arquivos = {
      uploadPopupPhoto: jest.fn().mockResolvedValue('popup/a.png'),
      buildUrl: jest.fn().mockReturnValue('https://cdn/popup/a.png'),
    };
    const banco = prisma as unknown as PrismaService;
    const gateway = new PushGatewayFalso();
    const produtor = new ProdutorFalso();
    const tokens = new PushTokenService(banco, gateway);
    const caixa = new CaixaDeEntradaService(banco);
    const service = new NotificationsService(
      tokens,
      caixa,
      new PushUnitarioService(banco, gateway, caixa, tokens),
      new AlertaVeiculoService(banco, gateway, produtor.comoProdutor()),
      {} as MarketingDisparoService,
      new PopupService(banco, arquivos as unknown as FileUploadService),
    );
    return { service, prisma, arquivos, gateway, produtor };
  }

  describe('registerExpoPushToken', () => {
    it('token com formato inválido: success false, sem tocar no banco', async () => {
      const { service, prisma } = montar();
      await expect(service.registerExpoPushToken(1, 'lixo')).resolves.toEqual({
        success: false,
        message: 'Token Expo inválido.',
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('usuário inexistente: success false com a mensagem do contrato', async () => {
      const { service, prisma } = montar();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.registerExpoPushToken(9, TOKEN)).resolves.toEqual({
        success: false,
        message: 'Usuario com ID 9 nao encontrado no banco.',
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('grava o token do usuário', async () => {
      const { service, prisma } = montar();
      prisma.user.findUnique.mockResolvedValue({ id: 9 });
      await expect(service.registerExpoPushToken(9, TOKEN)).resolves.toEqual({
        success: true,
        message: 'Token Expo registrado com sucesso.',
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { expoPushToken: TOKEN },
      });
    });
  });

  describe('sendPushNotification', () => {
    it('token inválido: não consulta usuário nem envia', async () => {
      const { service, prisma, gateway } = montar();
      await expect(
        service.sendPushNotification(1, 'lixo', 'T', 'B', {}),
      ).resolves.toEqual({ success: false, message: 'Token Expo inválido.' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(gateway.chamadas).toHaveLength(0);
    });

    it('usuário inexistente: não envia nem grava', async () => {
      const { service, prisma, gateway } = montar();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.sendPushNotification(5, TOKEN, 'T', 'B', {}),
      ).resolves.toEqual({
        success: false,
        message: 'Usuario com ID 5 nao encontrado no banco.',
      });
      expect(gateway.chamadas).toHaveLength(0);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('alerta de ignição com a preferência desligada: não envia nem grava', async () => {
      const { service, prisma, gateway } = montar();
      prisma.user.findUnique.mockResolvedValue({ notificacaoIgnicao: false });
      await expect(
        service.sendPushNotification(5, TOKEN, 'T', 'B', { ignition: 'on' }),
      ).resolves.toEqual({
        success: false,
        message: 'Preferencia de notificacao de ignicao desativada.',
      });
      expect(gateway.chamadas).toHaveLength(0);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('envio aceito: uma mensagem no formato do app e uma linha na caixa de entrada', async () => {
      const { service, prisma, gateway } = montar();
      prisma.user.findUnique.mockResolvedValue({ notificacaoIgnicao: true });

      await expect(
        service.sendPushNotification(5, TOKEN, 'Título', 'Corpo', {
          plate: 'ABC1D23',
          ignition: 'on',
        }),
      ).resolves.toEqual({
        success: true,
        message: 'Notificação enviada com sucesso.',
        notificationId: 77,
      });

      expect(gateway.chamadas).toHaveLength(1);
      expect(gateway.chamadas[0]).toEqual([
        expect.objectContaining({
          to: TOKEN,
          title: 'Título',
          body: 'Corpo',
          data: { plate: 'ABC1D23', ignition: 'on' },
          sound: 'default',
          priority: 'high',
          channelId: 'alerts_v2',
          // Acordam o app no iOS em segundo plano: fazem parte do formato.
          _contentAvailable: true,
          mutableContent: true,
        }),
      ]);
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
        userId: 5,
        expoPushToken: TOKEN,
        title: 'Título',
        body: 'Corpo',
        data: { plate: 'ABC1D23', ignition: 'on' },
      });
    });

    it('recusa do Expo: success false com a mensagem do ticket, sem lançar', async () => {
      const { service, prisma, gateway } = montar();
      prisma.user.findUnique.mockResolvedValue({ notificacaoIgnicao: true });
      gateway.responder = () => [
        { status: 'recusado', mensagem: 'MessageTooBig' },
      ];

      const r = await service.sendPushNotification(5, TOKEN, 'T', 'B', {});

      expect(r).toMatchObject({ success: false, message: 'MessageTooBig' });
    });

    it('Expo fora do ar: a fachada devolve success false, sem lançar', async () => {
      const { service, prisma, gateway } = montar();
      prisma.user.findUnique.mockResolvedValue({ notificacaoIgnicao: true });
      // O adaptador real converte a exceção do SDK em `falha_transporte`.
      gateway.responder = PushGatewayFalso.semResposta;

      const r = await service.sendPushNotification(5, TOKEN, 'T', 'B', {});

      expect(r).toMatchObject({
        success: false,
        message: 'Erro ao enviar notificação.',
      });
    });
  });

  describe('caixa de entrada', () => {
    const linha = {
      id: 3,
      userId: 5,
      title: 'T',
      body: 'B',
      data: { a: 1 },
      read: false,
      sentAt: new Date('2026-11-20T10:00:00Z'),
      readAt: null,
      deleted: false,
      expoPushToken: TOKEN,
    };

    it('não lidas: filtra não lidas e não excluídas, da mais recente para a mais antiga', async () => {
      const { service, prisma } = montar();
      prisma.notification.findMany.mockResolvedValue([linha]);
      prisma.notification.count.mockResolvedValue(4);

      const r = await service.getUnreadNotifications(5, 10, 20);

      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: { userId: 5, read: false, deleted: false },
        orderBy: { sentAt: 'desc' },
        skip: 20,
        take: 10,
      });
      expect(r).toEqual({
        notifications: [
          {
            id: 3,
            title: 'T',
            body: 'B',
            data: { a: 1 },
            read: false,
            sentAt: linha.sentAt,
            readAt: null,
            deleted: false,
          },
        ],
        total: 4,
        unreadCount: 4,
      });
    });

    it('todas: padrão de 50 por página, sem `unreadCount`', async () => {
      const { service, prisma } = montar();
      prisma.notification.findMany.mockResolvedValue([linha]);
      prisma.notification.count.mockResolvedValue(9);

      const r = await service.getAllNotifications(5);

      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: { userId: 5, deleted: false },
        orderBy: { sentAt: 'desc' },
        skip: 0,
        take: 50,
      });
      expect(r.total).toBe(9);
      expect(r.unreadCount).toBeUndefined();
      expect(r.notifications).toHaveLength(1);
    });

    it('marcar como lida: 404 se não existe, 403 se é de outro usuário', async () => {
      const { service, prisma } = montar();
      prisma.notification.findUnique.mockResolvedValue(null);
      await expect(service.markAsRead(5, 3)).rejects.toThrow(NotFoundException);

      prisma.notification.findUnique.mockResolvedValue({ ...linha, userId: 6 });
      await expect(service.markAsRead(5, 3)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });

    it('marcar como lida: grava `read` e `readAt` e devolve a linha', async () => {
      const { service, prisma } = montar();
      prisma.notification.findUnique.mockResolvedValue(linha);
      prisma.notification.update.mockResolvedValue({ ...linha, read: true });

      await expect(service.markAsRead(5, 3)).resolves.toMatchObject({
        id: 3,
        read: true,
      });
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { read: true, readAt: expect.any(Date) },
      });
    });

    it('marcar todas como lidas devolve a contagem', async () => {
      const { service, prisma } = montar();
      prisma.notification.updateMany.mockResolvedValue({ count: 7 });

      await expect(service.markAllAsRead(5)).resolves.toEqual({ count: 7 });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 5, read: false },
        data: { read: true, readAt: expect.any(Date) },
      });
    });

    it('excluir: 404 inexistente, 403 de outro usuário, 404 já excluída', async () => {
      const { service, prisma } = montar();
      prisma.notification.findUnique.mockResolvedValue(null);
      await expect(service.deleteNotification(5, 3)).rejects.toThrow(
        NotFoundException,
      );
      prisma.notification.findUnique.mockResolvedValue({ ...linha, userId: 6 });
      await expect(service.deleteNotification(5, 3)).rejects.toThrow(
        ForbiddenException,
      );
      prisma.notification.findUnique.mockResolvedValue({
        ...linha,
        deleted: true,
      });
      await expect(service.deleteNotification(5, 3)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });

    it('excluir é exclusão lógica', async () => {
      const { service, prisma } = montar();
      prisma.notification.findUnique.mockResolvedValue(linha);

      await expect(service.deleteNotification(5, 3)).resolves.toBeUndefined();
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { deleted: true },
      });
    });

    it('excluir todas devolve `deletedCount`', async () => {
      const { service, prisma } = montar();
      prisma.notification.updateMany.mockResolvedValue({ count: 12 });

      await expect(service.deleteAllUserNotifications(5)).resolves.toEqual({
        deletedCount: 12,
      });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 5, deleted: false },
        data: { deleted: true },
      });
    });

    it('limpeza apaga o que foi criado antes do corte', async () => {
      const { service, prisma } = montar();
      prisma.notification.deleteMany.mockResolvedValue({ count: 3 });

      await expect(service.cleanOldNotifications(10)).resolves.toEqual({
        deletedCount: 3,
      });
      const corte = prisma.notification.deleteMany.mock.calls[0][0].where
        .createdAt.lt as Date;
      const dias = (Date.now() - corte.getTime()) / 86_400_000;
      expect(dias).toBeGreaterThan(9.9);
      expect(dias).toBeLessThan(10.1);
    });

    it('saveNotification grava a linha e a devolve', async () => {
      const { service, prisma } = montar();

      await expect(
        service.saveNotification(5, TOKEN, 'T', 'B', { a: 1 }),
      ).resolves.toEqual({ id: 77 });
      expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
        userId: 5,
        expoPushToken: TOKEN,
        title: 'T',
        body: 'B',
        data: { a: 1 },
        sentAt: expect.any(Date),
      });
    });
  });

  describe('pop-up', () => {
    it('ativo: o mais recente com `active`', async () => {
      const { service, prisma } = montar();
      prisma.notificationPopup.findFirst.mockResolvedValue({ id: 1 });

      await expect(service.getActivePopup()).resolves.toEqual({ id: 1 });
      expect(prisma.notificationPopup.findFirst).toHaveBeenCalledWith({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('criar sem imagem: 400', async () => {
      const { service, prisma } = montar();
      await expect(
        service.upsertPopup(undefined, { active: true }, 3),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.notificationPopup.create).not.toHaveBeenCalled();
    });

    it('criar com arquivo: sobe a imagem e grava a URL pública', async () => {
      const { service, prisma, arquivos } = montar();
      prisma.notificationPopup.create.mockResolvedValue({ id: 4 });
      const imagem = { originalname: 'a.png' } as Express.Multer.File;

      await expect(
        service.upsertPopup(
          undefined,
          { linkUrl: 'https://x', linkLabel: 'Ver', active: true },
          3,
          imagem,
        ),
      ).resolves.toEqual({ id: 4 });
      expect(arquivos.uploadPopupPhoto).toHaveBeenCalledWith(imagem);
      expect(prisma.notificationPopup.create).toHaveBeenCalledWith({
        data: {
          linkUrl: 'https://x',
          linkLabel: 'Ver',
          active: true,
          userId: 3,
          imageUrl: 'https://cdn/popup/a.png',
        },
      });
    });

    it('atualizar sem imagem nova: não ativa e mantém a imagem gravada', async () => {
      const { service, prisma } = montar();
      prisma.notificationPopup.findUnique.mockResolvedValue({ id: 4 });
      prisma.notificationPopup.update.mockResolvedValue({ id: 4 });

      await service.upsertPopup(4, { active: true }, 3);

      expect(prisma.notificationPopup.update).toHaveBeenCalledWith({
        where: { id: 4 },
        data: {
          linkUrl: undefined,
          linkLabel: undefined,
          active: false,
          userId: 3,
        },
      });
    });

    it('atualizar pop-up inexistente: 404', async () => {
      const { service, prisma } = montar();
      prisma.notificationPopup.findUnique.mockResolvedValue(null);
      await expect(
        service.upsertPopup(4, { imageUrl: 'https://x/a.png' }, 3),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('dispararNotificacaoVeiculoWebhook', () => {
    it('evento sem mapeamento: nada é consultado nem enviado', async () => {
      const { service, prisma, gateway, produtor } = montar();
      await expect(
        service.dispararNotificacaoVeiculoWebhook('CHASSI', 99, 'Outro'),
      ).resolves.toEqual({ sent: 0, skipped: 0 });
      expect(prisma.userVehicle.findMany).not.toHaveBeenCalled();
      expect(gateway.chamadas).toHaveLength(0);
      expect(produtor.jobs).toHaveLength(0);
    });

    // Mudou depois da extração, de propósito: o alerta passou a ser POR
    // VEÍCULO (`UserVehicle.notificacaoIgnicao`), com a preferência da conta
    // valendo só para o vínculo que ainda não tem valor próprio.
    it('busca os veículos ativos de usuários ativos; o corte do alerta é por veículo, com a conta como padrão', async () => {
      const { service, prisma } = montar();
      await expect(
        service.dispararNotificacaoVeiculoWebhook('CHASSI', 32, null),
      ).resolves.toEqual({ sent: 0, skipped: 0 });
      expect(prisma.userVehicle.findMany).toHaveBeenCalledWith({
        where: { chassi: 'CHASSI', isActive: true, user: { isActive: true } },
        select: {
          userId: true,
          plate: true,
          notificacaoIgnicao: true,
          user: { select: { notificacaoIgnicao: true } },
        },
      });
    });
  });
});
