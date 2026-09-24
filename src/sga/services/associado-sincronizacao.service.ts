import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { baseTag } from 'src/shared/log.util';
import {
  CadastroLocal,
  CamposCadastroSincronizados,
  calcularAlteracoesCadastro,
  extrairCadastroSga,
} from 'src/sga/helpers/associado-sga.helper';

/**
 * Recorte do `user` necessário para sincronizar. É o mesmo registro que
 * `SgaService` já lê para resolver o CPF — a sincronização não faz leitura
 * extra no banco.
 */
export type UsuarioSincronizavel = CadastroLocal & {
  id: number;
  /** CPF somente dígitos (o mesmo usado na consulta ao SGA). */
  cpf: string;
  baseOrigin: string | null;
};

/**
 * Mantém o cadastro local (`user.name/email/cep/address`) alinhado ao SGA.
 *
 * Quem chama já tem o corpo de `GET /associado/buscar/{cpf}` em mãos (o app
 * consulta esse endpoint ao abrir), então a sincronização não custa nenhuma
 * requisição extra à Hinova. Custo no caminho comum (dados iguais): zero
 * escritas — só uma comparação em memória. Só há `UPDATE` quando algum campo
 * realmente mudou no SGA.
 *
 * O SGA é a fonte de verdade: um valor diferente no SGA sobrescreve o local,
 * inclusive edições feitas pelo app ou pelo suporte. Campos vazios no SGA
 * nunca apagam o valor local.
 */
@Injectable()
export class AssociadoSincronizacaoService {
  private readonly logger = new Logger(AssociadoSincronizacaoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dispara a sincronização sem bloquear a resposta ao app.
   * Qualquer falha é apenas logada — nunca afeta a consulta ao SGA.
   */
  sincronizarEmSegundoPlano(
    usuario: UsuarioSincronizavel,
    respostaSga: unknown,
  ): void {
    void this.sincronizar(usuario, respostaSga).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `${baseTag(usuario.baseOrigin ?? undefined)} Falha ao sincronizar cadastro do usuário id=${usuario.id} com o SGA: ${message}`,
      );
    });
  }

  /**
   * Compara o cadastro local com o retorno do SGA e grava só o que mudou.
   * Retorna os campos gravados (objeto vazio quando nada foi alterado).
   */
  async sincronizar(
    usuario: UsuarioSincronizavel,
    respostaSga: unknown,
  ): Promise<Partial<CamposCadastroSincronizados>> {
    const cadastroSga = extrairCadastroSga(respostaSga);
    if (!cadastroSga) return {};

    // Trava de segurança: nunca gravar dados de outro CPF no usuário.
    if (cadastroSga.cpf && cadastroSga.cpf !== usuario.cpf) {
      this.logger.warn(
        `${baseTag(usuario.baseOrigin ?? undefined)} CPF retornado pelo SGA difere do usuário id=${usuario.id}; sincronização ignorada`,
      );
      return {};
    }

    const alteracoes = calcularAlteracoesCadastro(usuario, cadastroSga);
    const campos = Object.keys(alteracoes);
    if (campos.length === 0) return {};

    await this.prisma.user.update({
      where: { id: usuario.id },
      data: alteracoes,
    });

    // Só os nomes dos campos: valores são dados pessoais.
    this.logger.log(
      `${baseTag(usuario.baseOrigin ?? undefined)} Cadastro do usuário id=${usuario.id} atualizado a partir do SGA: ${campos.join(', ')}`,
    );

    return alteracoes;
  }
}
