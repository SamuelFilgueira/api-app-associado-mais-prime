import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateAdminPanelUserDto } from './dto/create-admin-panel-user.dto';
import { UpdateAdminPanelUserDto } from './dto/update-admin-panel-user.dto';
import { AdminPanelLoginDto } from './dto/admin-panel-login.dto';

@Injectable()
export class AdminPanelUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(data: AdminPanelLoginDto) {
    const adminPanelUser = await this.prisma.adminPanelUser.findUnique({
      where: { email: data.email },
    });

    if (!adminPanelUser) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const passwordMatches = await bcrypt.compare(
      data.password,
      adminPanelUser.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const payload = {
      sub: adminPanelUser.id,
      email: adminPanelUser.email,
      username: adminPanelUser.name,
      role: UserRole.ADMIN,
      adminRole: adminPanelUser.role,
    };

    return {
      access_token: this.jwtService.sign(payload, { audience: 'admin-panel' }),
      user: {
        id: adminPanelUser.id,
        name: adminPanelUser.name,
        email: adminPanelUser.email,
        role: adminPanelUser.role,
      },
    };
  }

  /**
   * Autoalteração de senha do usuário logado no painel.
   *
   * Diferente do PATCH /admin-panel/users/:id (CRUD administrativo), aqui:
   *  - o alvo é SEMPRE o dono do token (id vem do JWT, nunca do body/rota);
   *  - a senha atual é exigida — um token vazado não basta para trocar;
   *  - qualquer perfil do painel pode usar (REVISTORIA, MARKETING, ...), pois
   *    a claim `adminRole` só existe em tokens emitidos pelo login do painel.
   *    Tokens do app móvel (mesmo com role ADMIN) não a possuem — e sem esta
   *    barreira um usuário do app com id coincidente alcançaria a conta do
   *    painel de mesmo id.
   */
  async changeOwnPassword(
    userId: number,
    adminRole: unknown,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!adminRole) {
      throw new ForbiddenException(
        'Recurso exclusivo de usuários do painel administrativo',
      );
    }

    const user = await this.prisma.adminPanelUser.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário administrativo não encontrado');
    }

    const currentMatches = await bcrypt.compare(currentPassword, user.password);
    if (!currentMatches) {
      throw new UnauthorizedException('Senha atual incorreta');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'A nova senha deve ser diferente da senha atual',
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await this.prisma.adminPanelUser.update({
      where: { id: userId },
      data: { password: passwordHash },
    });

    return { success: true, message: 'Senha alterada com sucesso' };
  }

  async create(data: CreateAdminPanelUserDto) {
    const existing = await this.prisma.adminPanelUser.findUnique({
      where: { email: data.email },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('E-mail já cadastrado para administração');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    return this.prisma.adminPanelUser.create({
      data: {
        name: data.name,
        email: data.email,
        password: passwordHash,
        role: data.role,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findAll() {
    return this.prisma.adminPanelUser.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async update(id: number, data: UpdateAdminPanelUserDto) {
    const existing = await this.prisma.adminPanelUser.findUnique({
      where: { id },
      select: { id: true, email: true },
    });

    if (!existing) {
      throw new NotFoundException('Usuário administrativo não encontrado');
    }

    if (data.email && data.email !== existing.email) {
      const emailInUse = await this.prisma.adminPanelUser.findUnique({
        where: { email: data.email },
        select: { id: true },
      });

      if (emailInUse) {
        throw new BadRequestException(
          'E-mail já cadastrado para administração',
        );
      }
    }

    const updateData: {
      name?: string;
      email?: string;
      password?: string;
      role?: UpdateAdminPanelUserDto['role'];
    } = {
      name: data.name,
      email: data.email,
      role: data.role,
    };

    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    return this.prisma.adminPanelUser.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async remove(id: number) {
    const existing = await this.prisma.adminPanelUser.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Usuário administrativo não encontrado');
    }

    await this.prisma.adminPanelUser.delete({ where: { id } });

    return {
      success: true,
      message: 'Usuário administrativo removido com sucesso',
    };
  }
}
