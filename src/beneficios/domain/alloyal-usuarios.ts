import type { AlloyalUserDto } from 'src/beneficios/dto/alloyal-user.dto';

/**
 * Regras do usuário do associado na Alloyal (funções puras).
 */

/** Tag que identifica, na Alloyal, o usuário criado por este aplicativo. */
export const TAG_DO_APP = 'APP-ASSOCIADO';

export interface DadosDoNovoUsuario {
  name: string;
  cpf: string;
  email: string;
  password: string;
}

/** Só os dígitos de um CPF ou de um id. */
export function apenasDigitos(valor: unknown): string {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor).replace(/\D/g, '')
    : '';
}

/** Corpo do cadastro (`POST .../users`). Aqui a tag vai como texto. */
export function corpoDeCriacao(dados: DadosDoNovoUsuario) {
  return {
    name: dados.name,
    cpf: dados.cpf,
    email: dados.email,
    password: dados.password,
    user_tags: TAG_DO_APP,
  };
}

/**
 * A Alloyal faz upsert por CPF: se o usuário já existia no business, o
 * cadastro devolve o registro antigo SEM gravar os dados novos. Se esse
 * registro está desativado, o login responderia 403 — é preciso reativar.
 */
export function precisaReativar(usuario: unknown): boolean {
  return (
    !!usuario &&
    typeof usuario === 'object' &&
    (usuario as { active?: unknown }).active === false
  );
}

/** Corpo da reativação (`PATCH .../users/:cpf`). Aqui a tag vai em lista. */
export function corpoDeReativacao(dados: DadosDoNovoUsuario) {
  return {
    name: dados.name,
    email: dados.email,
    password: dados.password,
    active: true,
    user_tags: [TAG_DO_APP],
  };
}

/** A busca devolve uma lista; qualquer outra coisa conta como "ninguém". */
export function listaDeUsuarios(corpo: unknown): AlloyalUserDto[] {
  return Array.isArray(corpo) ? (corpo as AlloyalUserDto[]) : [];
}

/**
 * O `id` pedido é de um usuário da Alloyal cadastrado com o CPF do
 * associado? A busca da Alloyal é por termo e pode trazer homônimos de
 * outro CPF: só vale o registro que bate nas duas coisas.
 */
export function usuarioPertenceAoCpf(
  usuarios: unknown,
  idPedido: string,
  cpfDoAssociado: string,
): boolean {
  return listaDeUsuarios(usuarios).some(
    (usuario) =>
      String(usuario?.id) === idPedido &&
      apenasDigitos(usuario?.cpf) === cpfDoAssociado,
  );
}
