import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isTenantBase } from 'src/config/tenant.config';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import {
  AtualizarRodadaDto,
  CriarRodadaDto,
  ListarRodadasQuery,
} from 'src/associado-sorte/dto/rodada.dto';
import {
  SorteAutor,
  SorteLancamentoTipo,
  SorteMecanica,
  SorteModoCredito,
  SorteRodadaEstado,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro409, erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import { metaPaginacao } from 'src/associado-sorte/helpers/sorte.helpers';
import {
  edicaoPermitida,
  RodadaAdminView,
  toParticipanteAdmin,
  toRodadaAdmin,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import {
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';

const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

/** Campos de regra de uma rodada, já coerentes com a mecânica. */
interface RodadaNormalizada {
  premioId: number;
  titulo: string | null;
  mecanica: SorteMecanica;
  quantidade: number;
  custoCreditos: number;
  modoCredito: SorteModoCredito;
  bilhetesMaximos: number;
  abertura: Date;
  encerramento: Date;
}

/**
 * Rodadas no painel (seção 4.3): agenda, publicação com validação de
 * estoque, edição travada depois da abertura, cancelamento com estorno e
 * duplicação semanal.
 */
@Injectable()
export class SorteRodadasService {
  private readonly logger = new Logger(SorteRodadasService.name);

  constructor(
    private readonly repository: SorteRodadasRepository,
    private readonly premiosRepository: SortePremiosRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly creditos: SorteCreditosService,
    private readonly ganhadores: SorteGanhadoresService,
  ) {}

  // ---------------------------------------------------------------- leitura

  async listar(query: ListarRodadasQuery) {
    const where: Prisma.SorteRodadaWhereInput = {
      ...(query.estado ? { estado: query.estado } : {}),
      ...(query.mecanica ? { mecanica: query.mecanica } : {}),
      ...(query.premioId ? { premioId: query.premioId } : {}),
      ...(query.baseOrigin
        ? { bases: { some: { baseOrigin: query.baseOrigin } } }
        : {}),
      ...(query.de || query.ate
        ? {
            abertura: {
              ...(query.de ? { gte: new Date(query.de) } : {}),
              ...(query.ate ? { lt: new Date(query.ate) } : {}),
            },
          }
        : {}),
    };
    const { data, total } = await this.repository.listarAdmin({
      where,
      order: query.order,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const agora = new Date();
    return {
      serverNow: agora,
      data: data.map((r) => toRodadaAdmin(r, agora)),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  async detalhar(id: number) {
    const rodada = await this.repository.buscarAdmin(id);
    if (!rodada) throw new NotFoundException('Rodada não encontrada');
    const [totalBilhetes, ganhadores] = await Promise.all([
      this.repository.somarBilhetes(id),
      this.ganhadores.listarDaRodada(id),
    ]);
    const agora = new Date();
    return {
      serverNow: agora,
      ...toRodadaAdmin(rodada, agora),
      totalBilhetes,
      ganhadores,
    };
  }

  async participantes(id: number, query: PaginacaoQuery) {
    const rodada = await this.repository.buscarAdmin(id);
    if (!rodada) throw new NotFoundException('Rodada não encontrada');
    const [{ data, total }, totalBilhetes] = await Promise.all([
      this.repository.listarParticipantes({
        rodadaId: id,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.repository.somarBilhetes(id),
    ]);
    return {
      data: data.map(toParticipanteAdmin),
      meta: metaPaginacao(query.page, query.limit, total),
      totalBilhetes,
    };
  }

  // ----------------------------------------------------------------- escrita

  async criar(dto: CriarRodadaDto): Promise<RodadaAdminView> {
    const baseOrigins = this.validarBases(dto.baseOrigins);
    const dados = this.normalizar({
      premioId: dto.premioId,
      titulo: dto.titulo ?? null,
      mecanica: dto.mecanica,
      quantidade: dto.quantidade,
      custoCreditos: dto.custoCreditos,
      modoCredito: dto.modoCredito ?? SorteModoCredito.CONSOME,
      bilhetesMaximos: dto.bilhetesMaximos ?? 1,
      abertura: new Date(dto.abertura),
      encerramento: new Date(dto.encerramento),
    });
    await this.exigirPremio(dados.premioId);

    const rodada = await this.repository.criar({
      data: {
        ...dados,
        quantidadeRestante: dados.quantidade,
        estado: SorteRodadaEstado.RASCUNHO,
      },
      baseOrigins,
    });
    this.logger.log(
      `Rodada #${rodada.id} (${rodada.mecanica}) criada em rascunho`,
    );
    return toRodadaAdmin(rodada, new Date());
  }

  /**
   * Edição (seção 4.3): rascunho e publicada-antes-da-abertura aceitam tudo;
   * depois da abertura só título e encerramento; encerrada/cancelada, nada.
   */
  async atualizar(
    id: number,
    dto: AtualizarRodadaDto,
  ): Promise<RodadaAdminView> {
    const existente = await this.repository.buscarAdmin(id);
    if (!existente) throw new NotFoundException('Rodada não encontrada');
    const basesAtuais = existente.bases.map((b) => b.baseOrigin).sort();
    const baseOrigins =
      dto.baseOrigins !== undefined
        ? this.validarBases(dto.baseOrigins)
        : undefined;

    await this.uow.executar(async (tx) => {
      const rodada = await tx.travarRodada(id);
      if (!rodada) throw new NotFoundException('Rodada não encontrada');
      const agora = new Date();
      const edicao = edicaoPermitida(rodada, agora);

      if (edicao === 'NENHUMA') {
        throw erro409(
          'RODADA_ENCERRADA',
          'Esta rodada não pode mais ser editada',
        );
      }

      const proposta = this.normalizar({
        premioId: dto.premioId ?? rodada.premioId,
        titulo: dto.titulo !== undefined ? dto.titulo : rodada.titulo,
        mecanica: dto.mecanica ?? rodada.mecanica,
        quantidade: dto.quantidade ?? rodada.quantidade,
        custoCreditos: dto.custoCreditos ?? rodada.custoCreditos,
        modoCredito: dto.modoCredito ?? rodada.modoCredito,
        bilhetesMaximos: dto.bilhetesMaximos ?? rodada.bilhetesMaximos,
        abertura: dto.abertura ? new Date(dto.abertura) : rodada.abertura,
        encerramento: dto.encerramento
          ? new Date(dto.encerramento)
          : rodada.encerramento,
      });

      if (edicao === 'PARCIAL') {
        const mudouRegra =
          proposta.premioId !== rodada.premioId ||
          proposta.mecanica !== rodada.mecanica ||
          proposta.quantidade !== rodada.quantidade ||
          proposta.custoCreditos !== rodada.custoCreditos ||
          proposta.modoCredito !== rodada.modoCredito ||
          proposta.bilhetesMaximos !== rodada.bilhetesMaximos ||
          proposta.abertura.getTime() !== rodada.abertura.getTime() ||
          (baseOrigins !== undefined &&
            baseOrigins.join(',') !== basesAtuais.join(','));
        if (mudouRegra) {
          throw erro409(
            'EDICAO_BLOQUEADA',
            'Depois da abertura só o título e o encerramento podem mudar',
          );
        }
        await tx.atualizarRodada(id, {
          titulo: proposta.titulo,
          encerramento: proposta.encerramento,
        });
        return;
      }

      // Edição total. Publicada (ainda não abriu): o estoque precisa caber.
      if (rodada.estado === SorteRodadaEstado.PUBLICADA) {
        await this.exigirEstoque(
          tx,
          id,
          proposta.premioId,
          proposta.quantidade,
        );
      } else if (proposta.premioId !== rodada.premioId) {
        await this.exigirPremio(proposta.premioId);
      }
      await tx.atualizarRodada(id, {
        ...proposta,
        quantidadeRestante: proposta.quantidade,
      });
      if (baseOrigins) await tx.substituirBases(id, baseOrigins);
    });

    return this.buscarView(id);
  }

  /**
   * Publica o rascunho. Com rodada e prêmio travados, valida que a quantidade
   * cabe no estoque já descontando as unidades restantes de outras rodadas
   * publicadas do mesmo prêmio (422 `ESTOQUE_INSUFICIENTE`).
   */
  async publicar(id: number, autor: SorteAutor): Promise<RodadaAdminView> {
    await this.uow.executar(async (tx) => {
      const rodada = await tx.travarRodada(id);
      if (!rodada) throw new NotFoundException('Rodada não encontrada');
      if (rodada.estado !== SorteRodadaEstado.RASCUNHO) {
        throw erro409(
          'RODADA_NAO_RASCUNHO',
          'Só rodadas em rascunho podem ser publicadas',
        );
      }
      if (rodada.encerramento.getTime() <= Date.now()) {
        throw erro422(
          'PERIODO_INVALIDO',
          'O encerramento precisa estar no futuro para publicar',
        );
      }
      if ((await tx.contarBases(id)) === 0) {
        throw erro422('BASE_INVALIDA', 'Selecione ao menos uma base');
      }
      await this.exigirEstoque(tx, id, rodada.premioId, rodada.quantidade);
      await tx.atualizarRodada(id, {
        estado: SorteRodadaEstado.PUBLICADA,
        quantidadeRestante: rodada.quantidade,
      });
    });
    this.logger.log(
      `Rodada #${id} publicada por ${autor.nome ?? `#${autor.id}`}`,
    );
    return this.buscarView(id);
  }

  /**
   * Cancela a rodada e devolve os créditos consumidos pelos inscritos
   * (lançamento `ESTORNO`), tudo na mesma transação. Ganhadores que já
   * levaram unidade (corrida/vitrine) são mantidos: cancele-os um a um na
   * tela de ganhadores, escolhendo o destino do estoque e dos créditos.
   */
  async cancelar(id: number, autor: SorteAutor): Promise<RodadaAdminView> {
    const resultado = await this.uow.executar(
      async (tx) => {
        const rodada = await tx.travarRodada(id);
        if (!rodada) throw new NotFoundException('Rodada não encontrada');
        if (rodada.estado === SorteRodadaEstado.CANCELADA) {
          return { estornos: 0, creditos: 0, jaCancelada: true };
        }
        if (rodada.estado === SorteRodadaEstado.ENCERRADA) {
          throw erro409(
            'RODADA_ENCERRADA',
            'Rodada encerrada não pode ser cancelada',
          );
        }

        const participacoes = (await tx.listarParticipacoes(id)).filter(
          (p) => p.creditosGastos > 0 && p.estornadoEm === null,
        );
        const carteiras = await tx.travarCarteiras(
          participacoes.map((p) => p.userId),
        );
        let creditos = 0;
        for (const p of participacoes) {
          const carteira = carteiras.get(p.userId);
          if (!carteira) continue;
          await this.creditos.lancar(tx, carteira, {
            tipo: SorteLancamentoTipo.ESTORNO,
            valor: p.creditosGastos,
            baseOrigin: p.baseOrigin,
            rodadaId: id,
            descricao: 'Rodada cancelada',
            autor,
          });
          creditos += p.creditosGastos;
        }

        const agora = new Date();
        await tx.marcarParticipacoesEstornadas(id, agora);
        await tx.atualizarRodada(id, { estado: SorteRodadaEstado.CANCELADA });
        return { estornos: participacoes.length, creditos, jaCancelada: false };
      },
      { longa: true },
    );

    if (!resultado.jaCancelada) {
      this.logger.log(
        `Rodada #${id} cancelada por ${autor.nome ?? `#${autor.id}`}: ${resultado.estornos} estorno(s), ${resultado.creditos} crédito(s) devolvidos`,
      );
    }
    return this.buscarView(id);
  }

  /**
   * "Repetir semanalmente por N semanas": cria N rodadas independentes em
   * rascunho, deslocadas de 7 em 7 dias. Não existe regra de recorrência.
   */
  async duplicar(id: number, semanas: number) {
    const origem = await this.repository.buscarAdmin(id);
    if (!origem) throw new NotFoundException('Rodada não encontrada');
    const baseOrigins = origem.bases.map((b) => b.baseOrigin);
    const agora = new Date();

    const criadas: RodadaAdminView[] = [];
    for (let semana = 1; semana <= semanas; semana++) {
      const deslocamento = semana * SEMANA_MS;
      const rodada = await this.repository.criar({
        data: {
          premioId: origem.premioId,
          titulo: origem.titulo,
          mecanica: origem.mecanica,
          quantidade: origem.quantidade,
          quantidadeRestante: origem.quantidade,
          custoCreditos: origem.custoCreditos,
          modoCredito: origem.modoCredito,
          bilhetesMaximos: origem.bilhetesMaximos,
          abertura: new Date(origem.abertura.getTime() + deslocamento),
          encerramento: new Date(origem.encerramento.getTime() + deslocamento),
          estado: SorteRodadaEstado.RASCUNHO,
        },
        baseOrigins,
      });
      criadas.push(toRodadaAdmin(rodada, agora));
    }
    this.logger.log(
      `Rodada #${id} duplicada em ${criadas.length} rascunho(s) semanais`,
    );
    return { data: criadas };
  }

  // ---------------------------------------------------------------- internos

  private async buscarView(id: number): Promise<RodadaAdminView> {
    const rodada = await this.repository.buscarAdmin(id);
    if (!rodada) throw new NotFoundException('Rodada não encontrada');
    return toRodadaAdmin(rodada, new Date());
  }

  private validarBases(baseOrigins: string[]): string[] {
    const unicas = [...new Set(baseOrigins)].sort();
    const invalida = unicas.find((b) => !isTenantBase(b));
    if (unicas.length === 0 || invalida !== undefined) {
      throw erro422(
        'BASE_INVALIDA',
        invalida
          ? `Base desconhecida: ${String(invalida)}`
          : 'Selecione ao menos uma base',
      );
    }
    return unicas;
  }

  /** Aplica as regras por mecânica e valida o período. */
  private normalizar(dados: RodadaNormalizada): RodadaNormalizada {
    if (
      Number.isNaN(dados.abertura.getTime()) ||
      Number.isNaN(dados.encerramento.getTime()) ||
      dados.encerramento.getTime() <= dados.abertura.getTime()
    ) {
      throw erro422(
        'PERIODO_INVALIDO',
        'O encerramento precisa ser depois da abertura',
      );
    }

    const ehSorteio = dados.mecanica === SorteMecanica.SORTEIO;
    // Vitrine sempre consome créditos.
    const modoCredito =
      dados.mecanica === SorteMecanica.RESGATE
        ? SorteModoCredito.CONSOME
        : dados.modoCredito;
    if (dados.mecanica === SorteMecanica.RESGATE && dados.custoCreditos < 1) {
      throw erro422(
        'CUSTO_INVALIDO',
        'A vitrine precisa de um custo em créditos maior que zero',
      );
    }
    // Bilhetes só existem em sorteio; em saldo mínimo é um bilhete só.
    const bilhetesMaximos =
      ehSorteio && modoCredito === SorteModoCredito.CONSOME
        ? Math.max(1, dados.bilhetesMaximos)
        : 1;

    return {
      ...dados,
      titulo: dados.titulo?.trim() || null,
      modoCredito,
      bilhetesMaximos,
    };
  }

  private async exigirPremio(premioId: number): Promise<void> {
    const premio = await this.premiosRepository.buscar(premioId);
    if (!premio || !premio.ativo) {
      throw new NotFoundException('Prêmio não encontrado ou inativo');
    }
  }

  /** Chamar com a rodada já travada; trava o prêmio (ordem rodada → prêmio). */
  private async exigirEstoque(
    tx: SorteTx,
    rodadaId: number,
    premioId: number,
    quantidade: number,
  ): Promise<void> {
    const premio = await tx.travarPremio(premioId);
    if (!premio || premio.excluido || !premio.ativo) {
      throw new NotFoundException('Prêmio não encontrado ou inativo');
    }
    const reservado = await tx.somarReservadoEmOutrasRodadas(
      premioId,
      rodadaId,
    );
    const disponivel = premio.estoque - reservado;
    if (quantidade > disponivel) {
      throw erro422(
        'ESTOQUE_INSUFICIENTE',
        `Estoque insuficiente: ${premio.estoque} em estoque, ${reservado} já comprometida(s) em outras rodadas, ${Math.max(0, disponivel)} disponível(is)`,
        {
          estoque: premio.estoque,
          reservado,
          disponivel: Math.max(0, disponivel),
        },
      );
    }
  }
}
