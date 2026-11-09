import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssociadoService } from 'src/associado/services/associado.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hash-novo'),
}));

describe('AssociadoService.changePassword — auditoria', () => {
  const usuario = {
    id: 10,
    cpf: '12345678901',
    email: 'associado@x.com',
    name: 'Associado Teste',
  };

  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    userPasswordChangeLog: { create: jest.Mock };
  };
  let service: AssociadoService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(usuario),
        update: jest.fn().mockResolvedValue(usuario),
      },
      userPasswordChangeLog: { create: jest.fn().mockResolvedValue({}) },
    };
    service = new AssociadoService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('registra reset feito pelo painel com id, e-mail e perfil do operador', async () => {
    const resposta = await service.changePassword(10, 'novaSenha', {
      userId: 7,
      email: 'operador@painel.com',
      adminRole: 'ADMIN',
      ipAddress: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
    });

    expect(resposta).toEqual({
      message: 'Senha alterada com sucesso',
      primeiroLogin: false,
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10 } }),
    );
    expect(prisma.userPasswordChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 10,
        userCpf: '12345678901',
        userEmail: 'associado@x.com',
        userName: 'Associado Teste',
        origem: 'PAINEL_ADMIN',
        adminPanelUserId: 7,
        adminPanelUserEmail: 'operador@painel.com',
        adminPanelUserRole: 'ADMIN',
        ipAddress: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
      }),
    });
  });

  it('registra troca pelo próprio associado como origem APP sem dados de painel', async () => {
    await service.changePassword(10, 'novaSenha', {
      userId: 10,
      email: 'associado@x.com',
      ipAddress: '200.1.1.1',
    });

    expect(prisma.userPasswordChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        origem: 'APP',
        adminPanelUserId: null,
        adminPanelUserEmail: null,
        adminPanelUserRole: null,
        ipAddress: '200.1.1.1',
      }),
    });
  });

  it('falha na auditoria não desfaz nem esconde a troca de senha', async () => {
    prisma.userPasswordChangeLog.create.mockRejectedValue(
      new Error('tabela inexistente'),
    );

    await expect(
      service.changePassword(10, 'novaSenha', {
        userId: 7,
        adminRole: 'ADMIN',
      }),
    ).resolves.toEqual(expect.objectContaining({ primeiroLogin: false }));
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('não audita quando a senha é inválida ou o usuário não existe', async () => {
    await expect(service.changePassword(10, '123')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.changePassword(99, 'novaSenha'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.userPasswordChangeLog.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
