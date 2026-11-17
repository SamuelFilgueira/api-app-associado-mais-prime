import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SorteTentativaAcao } from '@prisma/client';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { codigoDoErro } from 'src/associado-sorte/helpers/sorte-erros';
import { metaPaginacao } from 'src/associado-sorte/helpers/sorte.helpers';
import { toTentativaView } from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteNotificacoesAdminRepository } from 'src/associado-sorte/repositories/sorte-notificacoes-admin.repository';
import { baseTag } from 'src/shared/log.util';

/** Códigos que não viram tentativa (abuso/limite técnico, não regra de negócio). */
const IGNORADOS = new Set(['MUITAS_REQUISICOES']);

/** Chaves aceitas no contexto: nada de CPF, telefone ou texto livre do associado. */
const CHAVES_DO_CONTEXTO = new Set([
  'premioId',
  'campanhaId',
  'saldo',
  'necessario',
  'proximaRaspadaEm',
  'limitePorAssociado',
  'raspadasPorDia',
  'motivo',
  'rota',
]);

/**
 * Registro das tentativas que falharam (seção 2.9): raspar, comprar e o 403
 * `NAO_INSCRITO`. Nunca bloqueia a resposta: grava em segundo plano e só
 * loga se falhar.
 */
@Injectable()
export class SorteTentativaService {
  private readonly logger = new Logger(SorteTentativaService.name);

  constructor(private readonly repository: SorteNotificacoesAdminRepository) {}

  /** Grava a tentativa a partir do erro lançado (usa o `code` da exceção). */
  registrarErro(params: {
    userId: number;
    baseOrigin: string;
    acao: SorteTentativaAcao;
    erro: unknown;
    contexto?: Record<string, unknown>;
  }): void {
    const codigo = codigoDoErro(params.erro) ?? 'ERRO_INTERNO';
    if (IGNORADOS.has(codigo)) return;
    const extra = extrasDoErro(params.erro);
    this.registrar({
      userId: params.userId,
      baseOrigin: params.baseOrigin,
      acao: params.acao,
      codigo,
      contexto: { ...extra, ...params.contexto },
    });
  }

  /** Tentativas que falharam (extrato do associado no painel). */
  async listarDoAssociado(userId: number, query: PaginacaoQuery) {
    const { data, total } = await this.repository.listarTentativas({
      userId,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map(toTentativaView),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  registrar(params: {
    userId: number;
    baseOrigin: string;
    acao: SorteTentativaAcao;
    codigo: string;
    contexto?: Record<string, unknown>;
  }): void {
    if (!Number.isInteger(params.userId)) return;
    const contexto = limparContexto(params.contexto);
    this.repository
      .criarTentativa({
        userId: params.userId,
        baseOrigin: params.baseOrigin || 'DESCONHECIDA',
        acao: params.acao,
        codigo: params.codigo.slice(0, 60),
        contexto: contexto ?? Prisma.JsonNull,
      })
      .catch((erro: Error) =>
        this.logger.warn(
          `${baseTag(params.baseOrigin)} não foi possível registrar a tentativa ${params.acao}/${params.codigo} do associado #${params.userId}: ${erro.message}`,
        ),
      );
  }
}

function extrasDoErro(erro: unknown): Record<string, unknown> {
  const resposta = (erro as { getResponse?: () => unknown })?.getResponse?.();
  if (!resposta || typeof resposta !== 'object') return {};
  const { saldo, necessario, proximaRaspadaEm } = resposta as Record<
    string,
    unknown
  >;
  return { saldo, necessario, proximaRaspadaEm };
}

function limparContexto(
  contexto: Record<string, unknown> | undefined,
): Prisma.InputJsonObject | null {
  if (!contexto) return null;
  const limpo: Record<string, string | number | boolean> = {};
  for (const [chave, valor] of Object.entries(contexto)) {
    if (!CHAVES_DO_CONTEXTO.has(chave) || valor === undefined || valor === null)
      continue;
    if (valor instanceof Date) limpo[chave] = valor.toISOString();
    else if (typeof valor === 'number' || typeof valor === 'boolean')
      limpo[chave] = valor;
    else if (typeof valor === 'string') limpo[chave] = valor.slice(0, 120);
    else limpo[chave] = JSON.stringify(valor).slice(0, 120);
  }
  return Object.keys(limpo).length > 0 ? limpo : null;
}
