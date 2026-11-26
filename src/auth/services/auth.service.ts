import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RegisterDto } from 'src/auth/dto/register.dto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/database/prisma.service';
import { Prisma } from '@prisma/client';
import { MailService } from 'src/infra/mail/mail.service';
import { randomInt } from 'crypto';

const LETRAS_MAIUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LETRAS_MINUSCULAS = 'abcdefghijkmnopqrstuvwxyz';
const DIGITOS = '23456789';

/**
 * Senha temporária de 10 caracteres (5 maiúsculos + 5 minúsculos, letras e
 * números), sorteada com o gerador criptográfico do Node. `Math.random()` é
 * previsível e não serve para credencial. O alfabeto deixa de fora os
 * caracteres que se confundem na leitura do e-mail (0/O, 1/I/l).
 */
export function gerarSenhaTemporaria(): string {
  const sortear = (alfabeto: string, quantidade: number): string =>
    Array.from(
      { length: quantidade },
      () => alfabeto[randomInt(alfabeto.length)],
    ).join('');

  return (
    sortear(LETRAS_MAIUSCULAS + DIGITOS, 5) +
    sortear(LETRAS_MINUSCULAS + DIGITOS, 5)
  );
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
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
        role: true,
        expoPushToken: true,
        baseOrigin: true,
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
        role: true,
        baseOrigin: true,
      },
    });

    if (!dbUser) {
      throw new Error('Usuário não encontrado ao gerar JWT');
    }

    if (!dbUser.baseOrigin) {
      // Cadastro legado sem base definida: problema de dados, não do usuário.
      throw new InternalServerErrorException(
        'Não foi possível concluir o login. Entre em contato com a associação.',
      );
    }

    const payload = {
      sub: dbUser.id,
      cpf: dbUser.cpf,
      username: dbUser.name,
      role: dbUser.role,
      baseOrigin: dbUser.baseOrigin,
    };

    return {
      access_token: this.jwtService.sign(payload, { audience: 'mobile-app' }),
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
          baseOrigin: data.baseOrigin,
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
        // Única constraint de unicidade restante no cadastro é o CPF
        throw new BadRequestException('CPF já cadastrado');
      }

      throw error; // outros erros continuam sendo tratados pelo Nest
    }
  }

  /**
   * Gera uma senha aleatória, salva no banco (hash) e envia por e-mail ao usuário
   * @param cpf CPF do usuário
   */
  async resetPassword(
    cpf: string,
  ): Promise<{ message: string; email: string }> {
    const user = await this.prisma.user.findUnique({ where: { cpf } });

    if (!user) {
      throw new NotFoundException('Nenhuma conta encontrada com este CPF');
    }

    if (!user.email?.trim()) {
      throw new UnprocessableEntityException(
        'Esta conta não tem e-mail cadastrado. Entre em contato com a associação para atualizar seu cadastro.',
      );
    }

    const newPassword = gerarSenhaTemporaria();

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // O e-mail vai ANTES de gravar a senha: se o envio falhar, a senha atual
    // continua valendo. Na ordem inversa, uma falha do provedor trocava a
    // senha por uma que o usuário nunca recebeu e o deixava sem acesso.
    try {
      await this.mailService.sendPasswordReset(user.email, newPassword);
    } catch (error) {
      this.logger.error(
        `Redefinição de senha não concluída (userId=${user.id}): falha no envio do e-mail — senha mantida. ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível enviar o e-mail de recuperação de senha. Tente novamente em alguns minutos.',
      );
    }

    await this.prisma.user.update({
      where: { cpf },
      data: {
        passwordHash,
        primeiroLogin: true, // força troca de senha no próximo acesso
        updatedAt: new Date(),
      },
    });

    return {
      message: 'Nova senha enviada para o e-mail informado',
      email: user.email,
    };
  }
}
