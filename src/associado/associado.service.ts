import * as bcrypt from 'bcrypt';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { AuthService } from 'src/auth/auth.service';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { PrismaService } from 'src/prisma.service';
import { UpdateAssociadoDto } from './DTOs/update-associado.dto';

@Injectable()
export class AssociadoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  /**
   * Troca a senha do usuário autenticado
   * @param id ID do usuário
   * @param newPassword Nova senha
   */
  async changePassword(id: number, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Validar força da senha
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('Senha deve ter no mínimo 6 caracteres');
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: newPasswordHash,
        primeiroLogin: false, // Marcar que não é mais primeiro login
        updatedAt: new Date(),
      },
    });
    return {
      message: 'Senha alterada com sucesso',
      primeiroLogin: false,
    };
  }

  async primeiroAcesso(rawCpf: string) {
    const cpf = rawCpf?.replace(/\D/g, '');

    if (!cpf) {
      throw new BadRequestException('CPF é obrigatório');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ cpf }, { cpf: rawCpf }],
      },
    });

    if (existingUser) {
      throw new ConflictException('Usuário já cadastrado');
    }

    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;

    let response;
    try {
      response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.SGA_TOKEN}`,
        },
        validateStatus: () => true,
      });

      console.log('Resposta da API SGA:', response.data);
    } catch {
      throw new InternalServerErrorException('Erro ao consultar SGA');
    }

    const data = response?.data;

    if (
      response.status >= 400 ||
      data?.mensagem === 'Não aceitável' ||
      data?.error?.some((msg: string) =>
        msg.includes('Associado não encontrado'),
      )
    ) {
      throw new BadRequestException('Cpf de associado inválido para cadastro');
    }

    const {
      cpf: apiCpf,
      nome,
      email,
      cep,
      logradouro,
      bairro,
      cidade,
      numero,
    } = data || {};

    if (!apiCpf || !nome || !email) {
      throw new BadRequestException(
        'Dados do associado incompletos na API externa',
      );
    }

    const addressParts = [logradouro, numero, bairro, cidade].filter(Boolean);
    const address = addressParts.join(' ');

    const user = await this.authService.register({
      name: nome,
      email,
      cpf,
      password: cpf,
      cep,
      address,
      primeiroLogin: true,
    });

    // Gerar token JWT para login automático
    const loginResult = await this.authService.login({ cpf, id: user.id });

    return {
      message: 'Associado cadastrado com sucesso',
      access_token: loginResult.access_token,
      primeiroLogin: true,
    };
  }

  async findById(id: number) {
    const associado = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!associado) {
      throw new NotFoundException('Associado não encontrado');
    }

    return associado;
  }

  async updateAssociado(
    id: number,
    data: UpdateAssociadoDto,
    profilePhoto?: Express.Multer.File,
  ) {
    console.log('Id recebido para atualização:', id);
    console.log('Dados recebidos para atualização:', data);
    if (!id) throw new NotFoundException('ID do associado é obrigatório');

    const associado = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!associado) {
      throw new NotFoundException('Associado não encontrado');
    }

    // Se uma nova foto foi enviada, processa e salva
    if (profilePhoto) {
      // Remove a foto antiga se existir
      if (associado.profilePhotoUrl) {
        await this.fileUploadService.deleteProfilePhoto(
          associado.profilePhotoUrl,
        );
      }

      // Salva a nova foto e obtém o caminho
      const photoUrl =
        await this.fileUploadService.uploadProfilePhoto(profilePhoto);
      data.profilePhotoUrl = photoUrl;
    }

    return this.prisma.user.update({
      where: { id },
      data,
    });
  }
}
