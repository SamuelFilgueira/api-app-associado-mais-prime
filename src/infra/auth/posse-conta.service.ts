import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import {
  UsuarioAutenticado,
  ehAdmin,
  ehTokenDoPainel,
  exigirDocumentoProprioOuAdmin,
  somenteDigitos,
} from 'src/infra/auth/usuario-autenticado';

/**
 * Checagem de posse por documento para rotas que recebem CPF/CNPJ no path,
 * na query ou no corpo.
 *
 * O CPF do associado vem do próprio JWT (`cpf`, gravado no login). Tokens
 * antigos sem essa claim caem numa consulta ao banco pelo id.
 */
@Injectable()
export class PosseContaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Documento (só dígitos) do associado autenticado; `null` para o painel. */
  async documentoDoUsuario(
    user: UsuarioAutenticado | null | undefined,
  ): Promise<string | null> {
    if (!user || ehTokenDoPainel(user)) return null;

    const doToken = somenteDigitos(user.cpf);
    if (doToken) return doToken;

    const id = Number(user.userId);
    if (!Number.isInteger(id)) return null;

    const registro = await this.prisma.user.findUnique({
      where: { id },
      select: { cpf: true },
    });
    return somenteDigitos(registro?.cpf) || null;
  }

  /**
   * Lança 403 quando o documento alvo não é o do associado autenticado.
   * Tokens com `role` ADMIN (painel e ADMIN legado) passam, como hoje.
   */
  async exigirDocumentoProprioOuAdmin(
    user: UsuarioAutenticado | null | undefined,
    documentoAlvo: unknown,
  ): Promise<void> {
    if (ehAdmin(user)) return;
    const proprio = await this.documentoDoUsuario(user);
    exigirDocumentoProprioOuAdmin(user, proprio, documentoAlvo);
  }
}
