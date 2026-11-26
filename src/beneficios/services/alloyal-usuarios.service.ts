import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  apenasDigitos,
  corpoDeCriacao,
  corpoDeReativacao,
  listaDeUsuarios,
  precisaReativar,
  usuarioPertenceAoCpf,
} from 'src/beneficios/domain/alloyal-usuarios';
import { AlloyalCreateUserRequestDto } from 'src/beneficios/dto/alloyal-create-user.dto';
import { AlloyalUpdateUserRequestDto } from 'src/beneficios/dto/alloyal-update-user.dto';
import { AlloyalUserDto } from 'src/beneficios/dto/alloyal-user.dto';
import { baseDoToken } from 'src/beneficios/helpers/alloyal-contexto';
import {
  UsuarioAutenticado,
  ehAdmin,
  exigirDocumentoProprioOuAdmin,
} from 'src/infra/auth/usuario-autenticado';
import { AlloyalGateway } from 'src/integrations/alloyal/alloyal.gateway';
import { DomainError } from 'src/shared/erros/erros';
import { baseTag } from 'src/shared/log.util';

const MSG_OUTRO_USUARIO =
  'Você não tem permissão para acessar os dados de outra conta';

/** Quem está pedindo: o usuário e a base do JWT, como vieram da requisição. */
export interface SolicitanteAlloyal {
  usuario?: UsuarioAutenticado;
  base?: string;
}

/**
 * Usuário do associado na Alloyal (rotas administrativas).
 *
 * Estas chamadas usam a credencial de employee da EMPRESA, que enxerga e
 * altera qualquer usuário do business. Por isso a posse é conferida aqui,
 * antes de qualquer chamada: o associado só busca, cria e altera o usuário
 * do próprio CPF. `role` ADMIN passa, como nas demais rotas de conta.
 *
 * A ordem das checagens é contrato: primeiro a posse (403), depois a base do
 * token (erro fixo da rota), depois a Alloyal.
 */
@Injectable()
export class AlloyalUsuariosService {
  private readonly logger = new Logger(AlloyalUsuariosService.name);

  constructor(private readonly alloyal: AlloyalGateway) {}

  /** Usuários ativos da Alloyal com o CPF informado (o do próprio associado). */
  async buscarPorCpf(
    solicitante: SolicitanteAlloyal,
    cpf: string,
  ): Promise<AlloyalUserDto[]> {
    this.exigirCpfProprio(solicitante, cpf);
    const base = baseDoToken(solicitante.base);
    return listaDeUsuarios(await this.alloyal.buscarUsuariosPorCpf(base, cpf));
  }

  /**
   * Cadastra o associado na Alloyal. Se o CPF já existia e está desativado,
   * reativa com os dados novos (ver `precisaReativar`).
   */
  async criar(
    solicitante: SolicitanteAlloyal,
    dados: AlloyalCreateUserRequestDto,
  ): Promise<AlloyalUserDto> {
    this.exigirCpfProprio(solicitante, dados.cpf);
    const base = baseDoToken(solicitante.base);

    const usuario = (await this.alloyal.criarUsuario(
      base,
      corpoDeCriacao(dados),
    )) as AlloyalUserDto;
    if (!precisaReativar(usuario)) return usuario;

    this.logger.warn(
      `${baseTag(base)} usuário já existia na Alloyal e está desativado (id=${usuario.id}, activated_at=${usuario.activated_at}, default_auth_flow=${usuario.default_auth_flow}) — reativando com os dados novos`,
    );
    return this.alloyal.atualizarUsuario(
      base,
      dados.cpf,
      corpoDeReativacao(dados),
    ) as Promise<AlloyalUserDto>;
  }

  /**
   * Altera o usuário. O app envia no caminho o ID do usuário na Alloyal (e
   * não o CPF); os dois são aceitos.
   */
  async atualizar(
    solicitante: SolicitanteAlloyal,
    identificador: string,
    dados: AlloyalUpdateUserRequestDto,
  ): Promise<AlloyalUserDto> {
    await this.exigirUsuarioProprio(solicitante, identificador);
    const base = baseDoToken(solicitante.base);

    if (!apenasDigitos(identificador)) {
      // Só um ADMIN chega aqui: sem dígitos o caminho viraria a coleção.
      throw new DomainError(
        'ALLOYAL_USUARIO_INVALIDO',
        'Identificador do usuário inválido',
        { status: 400 },
      );
    }
    return this.alloyal.atualizarUsuario(
      base,
      identificador,
      dados,
    ) as Promise<AlloyalUserDto>;
  }

  private exigirCpfProprio(
    solicitante: SolicitanteAlloyal,
    cpf: unknown,
  ): void {
    exigirDocumentoProprioOuAdmin(
      solicitante.usuario,
      solicitante.usuario?.cpf,
      cpf,
    );
  }

  /**
   * Libera quando o identificador é o CPF do associado ou o id de um usuário
   * da Alloyal cadastrado com o CPF dele (o que exige uma consulta à
   * Alloyal; se ela falhar, a rota responde o erro fixo — nunca libera).
   */
  private async exigirUsuarioProprio(
    solicitante: SolicitanteAlloyal,
    identificador: string,
  ): Promise<void> {
    if (ehAdmin(solicitante.usuario)) return;

    const proprio = apenasDigitos(solicitante.usuario?.cpf);
    const alvo = apenasDigitos(identificador);
    if (!proprio || !alvo) throw new ForbiddenException(MSG_OUTRO_USUARIO);
    if (alvo === proprio) return;

    const usuarios = await this.alloyal.buscarUsuariosPorCpf(
      baseDoToken(solicitante.base),
      proprio,
    );
    if (!usuarioPertenceAoCpf(usuarios, alvo, proprio)) {
      throw new ForbiddenException(MSG_OUTRO_USUARIO);
    }
  }
}
