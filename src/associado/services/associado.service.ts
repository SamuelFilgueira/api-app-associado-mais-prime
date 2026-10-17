import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
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
import { AuthService } from 'src/auth/services/auth.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { PrismaService } from 'src/database/prisma.service';
import { UpdateAssociadoDto } from 'src/associado/dto/update-associado.dto';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { TENANT } from 'src/config/tenant.config';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';

/** Campos da resposta do SGA usados para classificar instabilidade. */
type RespostaSga = { status: number; data: unknown };

/**
 * Mensagem neutra exibida ao usuário quando o SGA está instável (rede, 5xx,
 * token bloqueado pela Hinova, corpo inesperado). Não revela o vendor nem
 * sugere problema no cadastro do associado.
 */
const MSG_SGA_INDISPONIVEL =
  'Não foi possível validar seus dados neste momento devido a uma indisponibilidade temporária do sistema. Por favor, tente novamente em alguns minutos.';

@Injectable()
export class AssociadoService {
  private readonly logger = new Logger(AssociadoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly fileUploadService: FileUploadService,
    private readonly sgaAuthService: SgaAuthService,
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
      if (!existingUser.primeiroLogin) {
        // Usuário já concluiu o primeiro acesso normalmente
        throw new ConflictException('Usuário já cadastrado');
      }

      // Cadastro parcial de tentativa anterior: redefine a senha padrão (CPF)
      // e devolve um token válido para que o app prossiga normalmente.
      this.logger.warn(
        `[PrimeiroAcesso] Usuário parcialmente cadastrado detectado para CPF ${cpf} (id=${existingUser.id}). Reativando fluxo.`,
      );
      const passwordHash = await bcrypt.hash(cpf, 10);
      await this.prisma.user.update({
        where: { id: existingUser.id },
        data: { passwordHash, updatedAt: new Date() },
      });
      const loginResult = await this.authService.login({
        cpf,
        id: existingUser.id,
      });
      return {
        message: 'Associado cadastrado com sucesso',
        access_token: loginResult.access_token,
        primeiroLogin: true,
      };
    }

    const baseOrigin = await this.detectBaseOrigin(cpf);

    const url = `${SGA_BASE_URL}/associado/buscar/${cpf}`;

    let response;
    try {
      response = await this.callSgaWithRetry(
        baseOrigin,
        {
          method: 'GET',
          url,
          validateStatus: () => true,
          compartilharEmVoo: true,
        },
        `buscar associado CPF=${cpf}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[PrimeiroAcesso] Todas as tentativas de consulta ao SGA falharam para CPF ${cpf}: ${msg}`,
      );
      throw new InternalServerErrorException(MSG_SGA_INDISPONIVEL);
    }

    if (response.status >= 500) {
      this.logger.error(
        `[PrimeiroAcesso] SGA retornou HTTP ${response.status} após todas as tentativas para CPF ${cpf}`,
      );
      throw new InternalServerErrorException(MSG_SGA_INDISPONIVEL);
    }

    // 401/403 (token bloqueado pela Hinova) ou 2xx sem JSON: instabilidade do
    // SGA, não CPF inválido. Mantém o 400 (contrato do app) e troca só o texto.
    if (this.respostaSgaIndisponivel(response as RespostaSga)) {
      this.logger.error(
        `[PrimeiroAcesso] SGA respondeu HTTP ${response.status} (indisponibilidade/bloqueio) para CPF ${cpf}`,
      );
      throw new BadRequestException(MSG_SGA_INDISPONIVEL);
    }

    const data = response?.data;

    if (
      response.status >= 400 ||
      data?.mensagem === 'Não aceitável' ||
      data?.error?.some((msg: string) =>
        msg.includes('Associado não encontrado'),
      ) ||
      !['ATIVO', 'INADIMPLENTE 20 DIAS', 'INADIMPLENTE'].includes(
        data?.descricao_situacao,
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
      this.logger.warn(
        `[PrimeiroAcesso] Cadastro do associado no SGA sem cpf/nome/email para CPF ${cpf} (base ${baseOrigin})`,
      );
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
    const url = `${SGA_BASE_URL}/associado/buscar/${cpf}`;

    // Check cache in DB first
    try {
      const existing = await this.prisma.user.findFirst({ where: { cpf } });
      if (existing?.baseOrigin) {
        return existing.baseOrigin;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(
        `Falha ao buscar baseOrigin no banco para cpf ${cpf}: ${message}`,
      );
      // continue to try external calls
    }

    // Tenta cada base sequencialmente com retry automático
    const bases: BaseOrigin[] = TENANT.baseNames;
    // Se alguma base falhou (rede, 5xx, 401/403, corpo inesperado), não dá
    // para afirmar que o CPF não existe: a mensagem deve ser de instabilidade.
    let houveFalhaSga = false;
    for (const base of bases) {
      try {
        const response = await this.callSgaWithRetry(
          base,
          {
            method: 'GET',
            url,
            validateStatus: () => true,
            timeout: 20000,
            compartilharEmVoo: true,
          },
          `detectBaseOrigin CPF=${cpf} base=${base}`,
        );
        if (response.status === 200) {
          return base;
        }
        if (this.respostaSgaIndisponivel(response as RespostaSga)) {
          houveFalhaSga = true;
          this.logger.warn(
            `[DetectBase] Base ${base} respondeu HTTP ${response.status} (indisponibilidade/bloqueio) para CPF ${cpf}`,
          );
        }
      } catch (err: unknown) {
        houveFalhaSga = true;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[DetectBase] Falha ao consultar base ${base} para CPF ${cpf} após todas as tentativas: ${msg}`,
        );
        // Continua para a próxima base antes de desistir
      }
    }

    // Mantém NotFoundException (404) nos dois casos para não alterar o
    // contrato com o app; só o texto muda.
    if (houveFalhaSga) {
      throw new NotFoundException(MSG_SGA_INDISPONIVEL);
    }
    throw new NotFoundException(
      'CPF não localizado no cadastro de associados. Verifique o número informado.',
    );
  }

  /**
   * Resposta do SGA que indica instabilidade/bloqueio, e não uma resposta de
   * negócio sobre o CPF: 401/403 (token inválido ou bloqueado pela Hinova),
   * 5xx, ou 2xx cujo corpo não é JSON (ex.: página HTML de erro do proxy).
   */
  private respostaSgaIndisponivel(response: RespostaSga): boolean {
    const { status, data } = response;
    if (status === 401 || status === 403 || status >= 500) return true;
    return status < 400 && (data === null || typeof data !== 'object');
  }

  async verificarSituacao(rawCpf: string) {
    const cpf = rawCpf?.replace(/\D/g, '');

    if (!cpf) {
      throw new BadRequestException('CPF é obrigatório');
    }

    const baseOrigin = await this.detectBaseOrigin(cpf);
    const url = `${SGA_BASE_URL}/buscar/situacao-associado/${cpf}`;

    let response;
    try {
      response = await this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
        method: 'GET',
        url,
        validateStatus: () => true,
        compartilharEmVoo: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Erro ao consultar SGA para verificar situação (CPF ${cpf}): ${msg}`,
      );
      throw new InternalServerErrorException(MSG_SGA_INDISPONIVEL);
    }

    // Instabilidade/bloqueio do SGA não é falta de permissão do associado.
    // Mantém o 403 (contrato do app) e troca só o texto.
    if (this.respostaSgaIndisponivel(response as RespostaSga)) {
      this.logger.error(
        `[VerificarSituacao] SGA respondeu HTTP ${response.status} (indisponibilidade/bloqueio) para CPF ${cpf}`,
      );
      throw new ForbiddenException(MSG_SGA_INDISPONIVEL);
    }

    const data = response?.data;

    if (
      response.status >= 400 ||
      data?.mensagem === 'Não aceitável' ||
      !['ATIVO', 'INADIMPLENTE 20 DIAS', 'INADIMPLENTE'].includes(
        data?.descricao,
      )
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

  async findByCpf(rawCpf: string) {
    const cpf = rawCpf?.replace(/\D/g, '');

    if (!cpf) {
      throw new BadRequestException('CPF é obrigatório');
    }

    const associado = await this.prisma.user.findFirst({
      where: {
        OR: [{ cpf }, { cpf: rawCpf }],
      },
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

  // ---------------------------------------------------------------------------
  // Helpers de resiliência
  // ---------------------------------------------------------------------------

  /**
   * Determina se um erro é transitório (rede, timeout, 5xx), ou seja, elegível
   * para retry automático.
   */
  private isTransientError(err: any): boolean {
    const message: string = err?.message ?? '';
    const transientCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNABORTED',
    ];
    if (transientCodes.some((code) => message.includes(code))) return true;
    if (message.toLowerCase().includes('network request failed')) return true;
    if (message.toLowerCase().includes('timeout')) return true;
    // Axios pode empacotar o status HTTP em err.response.status
    const status: number | undefined = err?.response?.status;
    if (status !== undefined && status >= 500) return true;
    return false;
  }

  /**
   * Executa uma chamada ao SGA com retry automático e exponential backoff.
   * Também trata respostas 5xx como falhas transitórias.
   *
   * @param baseOrigin Base de origem do associado
   * @param config     Configuração da requisição axios
   * @param label      Rótulo para os logs (ex.: 'buscar associado')
   * @param maxAttempts Número máximo de tentativas (padrão: 3)
   * @param baseDelayMs Atraso base em ms para o backoff (padrão: 1 000 ms)
   */
  private async callSgaWithRetry(
    baseOrigin: BaseOrigin,
    config: Parameters<SgaAuthService['executeRequestWithAuth']>[1],
    label: string,
    maxAttempts = 3,
    baseDelayMs = 1000,
  ) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = Date.now();
      try {
        const response = await this.sgaAuthService.executeRequestWithAuth(
          baseOrigin,
          config,
        );
        const elapsed = Date.now() - start;

        if (response.status >= 500) {
          this.logger.warn(
            `[SGA Retry] ${label} – tentativa ${attempt}/${maxAttempts} retornou HTTP ${response.status} em ${elapsed}ms`,
          );
          if (attempt < maxAttempts) {
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            this.logger.log(
              `[SGA Retry] Aguardando ${delay}ms antes da tentativa ${attempt + 1}…`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          // Esgotou as tentativas com 5xx – retorna para o caller decidir
          return response;
        }

        if (attempt > 1) {
          this.logger.log(
            `[SGA Retry] ${label} – sucesso na tentativa ${attempt} em ${elapsed}ms`,
          );
        }
        return response;
      } catch (err: unknown) {
        lastError = err;
        const elapsed = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[SGA Retry] ${label} – tentativa ${attempt}/${maxAttempts} falhou em ${elapsed}ms: ${msg}`,
        );

        if (attempt < maxAttempts && this.isTransientError(err)) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          this.logger.log(
            `[SGA Retry] Aguardando ${delay}ms antes da tentativa ${attempt + 1}…`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          break;
        }
      }
    }

    throw lastError;
  }
}
