import { ForbiddenException, HttpException, Logger } from '@nestjs/common';
import { ErroDeAplicacao, IntegrationError } from 'src/shared/erros/erros';

interface ErroFixo {
  status: number;
  mensagem: string;
  /**
   * Rotas de usuário: a recusa de posse (403 "outra conta") passa como está.
   * É a única resposta de erro destas rotas que não é o erro fixo.
   */
  passaRecusaDePosse?: true;
}

/**
 * CONTRATO DE ERRO das rotas `/alloyal/*` com o app.
 *
 * Qualquer falha dentro da rota — Alloyal fora, recusa da Alloyal, sessão
 * ausente, token sem base — sai com o status e a mensagem fixos abaixo. O
 * app decide só por `response.ok`; o motivo real fica no log.
 *
 * Este é o ÚNICO lugar que faz essa conversão (antes eram 20 `try/catch`
 * copiados no controller). Mudar um status aqui é mudar o contrato: só com
 * decisão combinada com o app.
 */
export const ERROS_FIXOS_ALLOYAL = {
  login: { status: 401, mensagem: 'Erro ao fazer login na API Alloyal' },
  categorias: { status: 500, mensagem: 'Erro ao buscar categorias' },
  organizacoesDaCategoria: {
    status: 500,
    mensagem: 'Erro ao buscar organizações da categoria',
  },
  organizacoes: { status: 500, mensagem: 'Erro ao buscar organizações' },
  organizacoesProximas: {
    status: 500,
    mensagem: 'Erro ao buscar organizações mais próximas',
  },
  filiais: { status: 500, mensagem: 'Erro ao buscar filiais da organização' },
  destaquesProximos: {
    status: 500,
    mensagem: 'Erro ao buscar organizações em destaque próximas',
  },
  destaquesOnline: {
    status: 500,
    mensagem: 'Erro ao buscar organizações online em destaque',
  },
  promocoes: { status: 500, mensagem: 'Erro ao buscar promoções' },
  cashbackExtrato: {
    status: 500,
    mensagem: 'Erro ao buscar transações de cashback',
  },
  cashbackResgate: {
    status: 500,
    mensagem: 'Erro ao solicitar resgate de cashback',
  },
  usuarioCriar: {
    status: 500,
    mensagem: 'Erro ao criar usuário na API Alloyal',
    passaRecusaDePosse: true,
  },
  usuarioAtualizar: {
    status: 500,
    mensagem: 'Erro ao atualizar usuário na API Alloyal',
    passaRecusaDePosse: true,
  },
  usuarioBuscar: {
    status: 500,
    mensagem: 'Erro ao buscar usuário por CPF',
    passaRecusaDePosse: true,
  },
  cuponsDaOrganizacao: {
    status: 500,
    mensagem: 'Erro ao buscar cupons da organização',
  },
  cuponsDaFilial: { status: 500, mensagem: 'Erro ao buscar cupons da filial' },
  cupomDetalhe: { status: 500, mensagem: 'Erro ao buscar detalhes do cupom' },
  cupomResgatarComCodigo: {
    status: 500,
    mensagem: 'Erro ao resgatar cupom com código',
  },
  pedidos: { status: 500, mensagem: 'Erro ao listar resgates de cupons' },
  cupomResgatar: { status: 500, mensagem: 'Erro ao resgatar cupom genérico' },
} as const satisfies Record<string, ErroFixo>;

export type RotaAlloyal = keyof typeof ERROS_FIXOS_ALLOYAL;

const logger = new Logger('AlloyalErroDeContrato');

/**
 * Executa o corpo da rota; se ele falhar, registra o erro ORIGINAL (tipado:
 * vendor, tipo, status da Alloyal, operação, base) e lança o erro fixo da
 * rota. O corpo devolvido ao app é `{ statusCode, message }`, como sempre.
 */
export async function comErroDeContrato<T>(
  rota: RotaAlloyal,
  operacao: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operacao();
  } catch (erro) {
    const fixo: ErroFixo = ERROS_FIXOS_ALLOYAL[rota];
    if (fixo.passaRecusaDePosse && erro instanceof ForbiddenException) {
      throw erro;
    }

    const linha = `[${rota}] ${descreverErro(erro)} → HTTP ${fixo.status} "${fixo.mensagem}"`;
    if (fixo.status >= 500) {
      logger.error(linha, ehErroInesperado(erro) ? erro.stack : undefined);
    } else {
      logger.warn(linha);
    }
    throw new HttpException(fixo.mensagem, fixo.status);
  }
}

/** Erro que ninguém classificou (bug): o único que precisa da pilha no log. */
function ehErroInesperado(erro: unknown): erro is Error {
  return (
    erro instanceof Error &&
    !(erro instanceof ErroDeAplicacao) &&
    !(erro instanceof HttpException)
  );
}

/** Resumo do erro original para o log. Exportada para teste. */
export function descreverErro(erro: unknown): string {
  if (erro instanceof IntegrationError) {
    const partes = [
      `vendor=${erro.vendor}`,
      `tipo=${erro.tipo}`,
      `statusVendor=${erro.statusVendor ?? '(sem resposta)'}`,
      `operacao=${textoDe(erro.detalhes?.operacao)}`,
      `base=${erro.base ?? '?'}`,
      `code=${erro.code}`,
    ];
    const motivo = erro.detalhes?.motivo ?? erro.detalhes?.faltando;
    if (motivo !== undefined) partes.push(`motivo=${textoDe(motivo)}`);
    return `IntegrationError ${partes.join(' ')}`;
  }
  if (erro instanceof ErroDeAplicacao) {
    return `${erro.name} code=${erro.code}: ${erro.message}`;
  }
  if (erro instanceof HttpException) {
    return `${erro.name} status=${erro.getStatus()}: ${erro.message}`;
  }
  if (erro instanceof Error) return `${erro.name}: ${erro.message}`;
  return `erro não tipado: ${String(erro)}`;
}

function textoDe(valor: unknown): string {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor)
    : '?';
}
