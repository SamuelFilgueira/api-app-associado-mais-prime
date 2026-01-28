import { Injectable, BadRequestException } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async getUserWithPlate(userId: number) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        plate: true,
        name: true,
        cpf: true,
        email: true,
        cep: true,
        address: true,
        primeiroLogin: true,
      },
    });
  }

  async validateUser(cpf: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { cpf } });
    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      const { passwordHash: _, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: { cpf: string; id: number }) {
    // Sempre aguarde a Promise:
    const dbUser = await this.prisma.user.findUnique({
      where: { cpf: user.cpf },
      select: {
        id: true,
        cpf: true,
        name: true,
      },
    });

    if (!dbUser) {
      throw new Error('Usuário não encontrado ao gerar JWT');
    }

    const payload = {
      sub: dbUser.id,
      cpf: dbUser.cpf,
      username: dbUser.name,
    };

    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  async register(data: RegisterDto) {
    try {
      const passwordHash = await bcrypt.hash(data.password, 10);

      const user = await this.prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          cpf: data.cpf,
          passwordHash,
          cep: data.cep,
          address: data.address,
          plate: data.plate,
          primeiroLogin: data.primeiroLogin ?? false,
          updatedAt: new Date(),
        },
      });

      const { passwordHash: _, ...result } = user;
      return result;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Verifica qual constraint falhou
        const field = error.meta?.target;

        if (field === 'User_email_key') {
          throw new BadRequestException('Email já cadastrado');
        }

        if (field === 'User_cpf_key') {
          throw new BadRequestException('CPF já cadastrado');
        }

        throw new BadRequestException('CPF ou email já cadastrado');
      }

      throw error; // outros erros continuam sendo tratados pelo Nest
    }
  }
}
