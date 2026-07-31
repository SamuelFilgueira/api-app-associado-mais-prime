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
