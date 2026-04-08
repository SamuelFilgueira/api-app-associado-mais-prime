import * as bcrypt from 'bcrypt';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { AuthService } from 'src/auth/auth.service';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { PrismaService } from 'src/prisma.service';
import { UpdateAssociadoDto } from './DTOs/update-associado.dto';
import { TokenResolverService, BaseOrigin } from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';

@Injectable()
export class AssociadoService {
  private readonly logger = new Logger(AssociadoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly fileUploadService: FileUploadService,
    private readonly tokenResolver: TokenResolverService,
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

    const baseOrigin = await this.detectBaseOrigin(cpf);
    this.logger.log(`${baseTag(baseOrigin)} Base origin detected for CPF ${cpf}`);
    const sgaToken = this.tokenResolver.resolveSgaToken(baseOrigin);

    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;

    let response;
    try {
      response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${sgaToken}`,
        },
        validateStatus: () => true,
      });

    } catch (err) {
      this.logger.error(`Erro ao consultar SGA: ${err?.message}`);
      throw new InternalServerErrorException('Erro ao consultar SGA');
    }

    const data = response?.data;

    if (
      response.status >= 400 ||
      data?.mensagem === 'Não aceitável' ||
      data?.error?.some((msg: string) =>
        msg.includes('Associado não encontrado'),
      ) ||
      !['ATIVO', 'INADIMPLENTE 20 DIAS'].includes(data?.descricao_situacao)
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
      baseOrigin,
    });

    // Gerar token JWT para login automático
    const loginResult = await this.authService.login({ cpf, id: user.id });

    return {
      message: 'Associado cadastrado com sucesso',
      access_token: loginResult.access_token,
      primeiroLogin: true,
    };
  }

  private async detectBaseOrigin(cpf: string): Promise<BaseOrigin> {
    const url = `https://api.hinova.com.br/api/sga/v2/associado/buscar/${cpf}`;

    // Check cache in DB first
    try {
      const existing = await this.prisma.user.findFirst({ where: { cpf } });
      if (existing?.baseOrigin) {
        this.logger.log(`Base origin found in DB for cpf ${cpf}: ${existing.baseOrigin}`);
        return existing.baseOrigin as BaseOrigin;
      }
    } catch (err) {
      this.logger.warn(`Falha ao buscar baseOrigin no banco para cpf ${cpf}: ${err?.message}`);
      // continue to try external calls
    }

    // Try sequentially to avoid duplicate calls
    try {
      const tokenMaisPrime = this.tokenResolver.resolveSgaToken('MAIS_PRIME');
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${tokenMaisPrime}` },
        validateStatus: () => true,
        timeout: 10000,
      });
      if (response.status === 200) return 'MAIS_PRIME';

      const tokenMaisPrimeRs = this.tokenResolver.resolveSgaToken('MAIS_PRIME_RS');
      const responseRS = await axios.get(url, {
        headers: { Authorization: `Bearer ${tokenMaisPrimeRs}` },
        validateStatus: () => true,
        timeout: 10000,
      });
      if (responseRS.status === 200) return 'MAIS_PRIME_RS';

      throw new NotFoundException('Usuário não encontrado em nenhuma base');
    } catch (error) {
      this.logger.error(`Erro ao detectar base: ${error?.message}`);
      throw new InternalServerErrorException('Erro ao consultar API SGA');
    }
  }

  async verificarSituacao(rawCpf: string) {
    const cpf = rawCpf?.replace(/\D/g, '');

    if (!cpf) {
      throw new BadRequestException('CPF é obrigatório');
    }

    const baseOrigin = await this.detectBaseOrigin(cpf);
    const sgaToken = this.tokenResolver.resolveSgaToken(baseOrigin);
    const url = `https://api.hinova.com.br/api/sga/v2/buscar/situacao-associado/${cpf}`;

    let response;
    try {
      response = await axios.get(url, {
        headers: { Authorization: `Bearer ${sgaToken}` },
        validateStatus: () => true,
      });
      this.logger.log(`Resposta da API SGA para verificar situação: status=${response.status}`);
    } catch (err) {
      this.logger.error(`Erro ao consultar SGA para verificar situação: ${err?.message}`);
      throw new InternalServerErrorException('Erro ao consultar SGA');
    }

    const data = response?.data;

    if (
      response.status >= 400 ||
      data?.mensagem === 'Não aceitável' ||
      !['ATIVO', 'INADIMPLENTE 20 DIAS'].includes(data?.descricao)
    ) {
      throw new ForbiddenException(
        'Associado sem permissão para acessar a aplicação',
      );
    }

    return {
      situacao: data?.descricao,
      mensagem: data?.mensagem || 'Situação verificada com sucesso',
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

  async findVehiclesByCpf(rawCpf: string) {
    const cpf = rawCpf?.replace(/\D/g, '');

    if (!cpf) {
      throw new BadRequestException('CPF é obrigatório');
    }

    const associado = await this.prisma.user.findFirst({
      where: {
        OR: [{ cpf }, { cpf: rawCpf }],
      },
      select: {
        id: true,
        cpf: true,
      },
    });

    if (!associado) {
      throw new NotFoundException('Associado não encontrado');
    }

    const vehicles = await this.prisma.userVehicle.findMany({
      where: {
        userId: associado.id,
      },
      orderBy: {
        id: 'desc',
      },
    });

    return {
      userId: associado.id,
      cpf: associado.cpf,
      vehicles,
    };
  }

  async updateAssociado(
    id: number,
    data: UpdateAssociadoDto,
    profilePhoto?: Express.Multer.File,
  ) {
    this.logger.log(`Id recebido para atualização: ${id}`);
    this.logger.log(
      `Dados recebidos para atualização: ${JSON.stringify(data)}`,
    );
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
