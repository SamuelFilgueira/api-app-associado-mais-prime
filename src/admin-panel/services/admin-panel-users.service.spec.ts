import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminPanelUsersService } from 'src/admin-panel/services/admin-panel-users.service';
import { PrismaService } from 'src/database/prisma.service';

describe('AdminPanelUsersService — changeOwnPassword()', () => {
  let service: AdminPanelUsersService;

  const mockPrisma = {
    adminPanelUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockJwt = { sign: jest.fn().mockReturnValue('token') };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminPanelUsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get(AdminPanelUsersService);
    jest.clearAllMocks();
  });

  const seedUser = async (senha: string) => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue({
      id: 7,
      password: await bcrypt.hash(senha, 10),
    });
  };

  it('altera a senha quando a senha atual confere', async () => {
    await seedUser('senha-antiga');
    mockPrisma.adminPanelUser.update.mockResolvedValue({});

    const result = await service.changeOwnPassword(
      7,
      'MARKETING',
      'senha-antiga',
      'senha-nova-123',
    );

    expect(result).toEqual({
      success: true,
      message: 'Senha alterada com sucesso',
    });

    // Persiste hash bcrypt da senha nova, nunca texto puro
    const updateArg = mockPrisma.adminPanelUser.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 7 });
    expect(updateArg.data.password).not.toBe('senha-nova-123');
    expect(
      await bcrypt.compare('senha-nova-123', updateArg.data.password),
    ).toBe(true);
  });

  it('rejeita com 401 quando a senha atual está errada', async () => {
    await seedUser('senha-antiga');

    await expect(
      service.changeOwnPassword(7, 'ADMIN', 'senha-errada', 'senha-nova-123'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockPrisma.adminPanelUser.update).not.toHaveBeenCalled();
  });

  it('rejeita com 400 quando a nova senha é igual à atual', async () => {
    await seedUser('mesma-senha');

    await expect(
      service.changeOwnPassword(7, 'ADMIN', 'mesma-senha', 'mesma-senha'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.adminPanelUser.update).not.toHaveBeenCalled();
  });

  it('rejeita com 403 tokens sem claim adminRole (app móvel)', async () => {
    await expect(
      service.changeOwnPassword(7, undefined, 'qualquer', 'senha-nova-123'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.adminPanelUser.findUnique).not.toHaveBeenCalled();
  });

  it('rejeita com 404 quando o usuário do token não existe mais', async () => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue(null);

    await expect(
      service.changeOwnPassword(99, 'ADMIN', 'qualquer', 'senha-nova-123'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminPanelUsersService — proteções do perfil ADMIN', () => {
  let service: AdminPanelUsersService;

  const mockPrisma = {
    adminPanelUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
  };

  const admin = { userId: 1, adminRole: 'ADMIN' };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminPanelUsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: { sign: jest.fn() } },
      ],
    }).compile();

    service = module.get(AdminPanelUsersService);
    jest.clearAllMocks();
  });

  it('não deixa o ADMIN excluir o próprio usuário', async () => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue({ id: 1, role: 'ADMIN' });

    await expect(service.remove(1, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.adminPanelUser.delete).not.toHaveBeenCalled();
  });

  it('não deixa excluir o último ADMIN', async () => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue({ id: 2, role: 'ADMIN' });
    mockPrisma.adminPanelUser.count.mockResolvedValue(1);

    await expect(service.remove(2, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.adminPanelUser.delete).not.toHaveBeenCalled();
  });

  it('exclui outro ADMIN quando ainda sobra um', async () => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue({ id: 2, role: 'ADMIN' });
    mockPrisma.adminPanelUser.count.mockResolvedValue(2);

    await expect(service.remove(2, admin)).resolves.toMatchObject({ success: true });
    expect(mockPrisma.adminPanelUser.delete).toHaveBeenCalledWith({ where: { id: 2 } });
  });

  it('não deixa o ADMIN tirar o próprio perfil Administrador', async () => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue({ id: 1, email: 'a@a.com', role: 'ADMIN' });

    await expect(
      service.update(1, { role: 'MARKETING' as any }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.adminPanelUser.update).not.toHaveBeenCalled();
  });

  it('permite o ADMIN editar o próprio nome sem mexer no perfil', async () => {
    mockPrisma.adminPanelUser.findUnique.mockResolvedValue({ id: 1, email: 'a@a.com', role: 'ADMIN' });
    mockPrisma.adminPanelUser.update.mockResolvedValue({ id: 1 });

    await service.update(1, { name: 'Novo nome' }, admin);
    expect(mockPrisma.adminPanelUser.update).toHaveBeenCalled();
    expect(mockPrisma.adminPanelUser.count).not.toHaveBeenCalled();
  });
});
