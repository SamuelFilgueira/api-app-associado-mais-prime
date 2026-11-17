import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isTenantBase } from 'src/config/tenant.config';
import {
  AjusteCreditosDto,
  BuscarAssociadosQuery,
} from 'src/associado-sorte/dto/associado.dto';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import {
  SorteAutor,
  SorteLancamentoTipo,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import { metaPaginacao } from 'src/associado-sorte/helpers/sorte.helpers';
import {
  toAssociadoAdmin,
  toLancamento,
  toLancamentoAdmin,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import {
  CarteiraTravada,
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';
import { baseTag } from 'src/shared/log.util';

export interface LancamentoParams {
  tipo: string;
  /** Com sinal: positivo credita, negativo debita. */
  valor: number;
  baseOrigin: string;
  rodadaId?: number | null;
  descricao?: string | null;
  autor?: SorteAutor | null;
}

/**
 * Carteira e extrato (seção 4.1). Toda alteração de saldo passa por
 * `lancar`, que grava o lançamento na mesma transação com o saldo resultante
 * e nunca deixa o saldo negativo.
 */
@Injectable()
export class SorteCreditosService {
  private readonly logger = new Logger(SorteCreditosService.name);

  constructor(
    private readonly repository: SorteCreditosRepository,
    private readonly uow: SorteUnidadeTrabalho,
  ) {}

  /**
   * Movimenta o saldo de uma carteira JÁ TRAVADA na transação. Atualiza o
   * objeto `carteira` em memória para lançamentos seguidos na mesma transação.
   * 422 `CREDITOS_INSUFICIENTES` se o saldo ficaria negativo.
   */
  async lancar(
    tx: SorteTx,
    carteira: CarteiraTravada,
    params: LancamentoParams,
  ): Promise<number> {
    const saldoApos = carteira.saldo + params.valor;
    if (saldoApos < 0) {
      throw erro422(
        'CREDITOS_INSUFICIENTES',
        'Você não tem créditos suficientes',
        { saldo: carteira.saldo, necessario: Math.abs(params.valor) },
      );
    }

    // Estorno devolve o que já tinha sido ganho: não conta como ganho novo.
    const contaComoGanho =
      params.valor > 0 && params.tipo !== SorteLancamentoTipo.ESTORNO;
    const totalGanho =
      carteira.totalGanho + (contaComoGanho ? params.valor : 0);

    await tx.atualizarCarteira(carteira.id, { saldo: saldoApos, totalGanho });
    await tx.criarLancamento({
      userId: carteira.userId,
      baseOrigin: params.baseOrigin,
      tipo: params.tipo,
      valor: params.valor,
      saldoApos,
      rodadaId: params.rodadaId ?? null,
      descricao: params.descricao ?? null,
      autorId: params.autor?.id ?? null,
      autorNome: params.autor?.nome ?? null,
    });

    carteira.saldo = saldoApos;
    carteira.totalGanho = totalGanho;
    return saldoApos;
  }

  async saldo(userId: number): Promise<number> {
    return (await this.repository.buscarCarteira(userId))?.saldo ?? 0;
  }

  async extratoApp(userId: number, query: PaginacaoQuery) {
    const { data, total } = await this.repository.listarLancamentos({
      userId,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      serverNow: new Date(),
      saldo: await this.saldo(userId),
      data: data.map(toLancamento),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  // ------------------------------------------------------------------ painel

  async buscarAssociados(query: BuscarAssociadosQuery) {
    const { data, total } = await this.repository.buscarAssociados({
      busca: query.busca,
      baseOrigin: query.baseOrigin,
      inscrito:
        query.inscrito === undefined ? undefined : query.inscrito === 'true',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map(toAssociadoAdmin),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  async extratoAdmin(userId: number, query: PaginacaoQuery) {
    const associado = await this.repository.buscarAssociado(userId);
    if (!associado) throw new NotFoundException('Associado não encontrado');

    const { data, total } = await this.repository.listarLancamentos({
      userId,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      associado: toAssociadoAdmin(associado),
      data: data.map(toLancamentoAdmin),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  /** Ajuste manual do painel: motivo obrigatório e autor registrado. */
  async ajustar(userId: number, dto: AjusteCreditosDto, autor: SorteAutor) {
    const associado = await this.repository.buscarAssociado(userId);
    if (!associado) throw new NotFoundException('Associado não encontrado');
    const baseOrigin = associado.baseOrigin;
    if (!baseOrigin || !isTenantBase(baseOrigin)) {
      throw erro422('BASE_INVALIDA', 'Associado sem base de origem válida');
    }

    await this.repository.garantirCarteira(userId, baseOrigin);
    const saldo = await this.uow.executar(async (tx) => {
      const carteira = await tx.travarCarteira(userId);
      if (!carteira) throw new NotFoundException('Carteira não encontrada');
      if (carteira.saldo + dto.valor < 0) {
        throw erro422(
          'CREDITOS_INSUFICIENTES',
          `O saldo do associado é ${carteira.saldo}; não dá para debitar ${Math.abs(dto.valor)}`,
          { saldo: carteira.saldo, necessario: Math.abs(dto.valor) },
        );
      }
      return this.lancar(tx, carteira, {
        tipo: SorteLancamentoTipo.AJUSTE_ADMIN,
        valor: dto.valor,
        baseOrigin,
        descricao: dto.motivo.trim(),
        autor,
      });
    });

    this.logger.log(
      `${baseTag(baseOrigin)} ajuste manual de ${dto.valor} crédito(s) no associado #${userId} por ${autor.nome ?? `#${autor.id}`} (saldo ${saldo})`,
    );
    return { userId, saldo };
  }
}
