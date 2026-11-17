import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SorteEstoqueMovimentoTipo,
  SorteGanhador,
  SorteGanhadorOrigem,
  SorteGanhadorSituacao,
  SorteMecanica,
} from '@prisma/client';
import {
  AtualizarGanhadorDto,
  ListarGanhadoresQuery,
} from 'src/associado-sorte/dto/ganhador.dto';
import {
  SorteAutor,
  SorteLancamentoTipo,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro409, erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import {
  gerarCodigo,
  mascararTelefone,
  metaPaginacao,
  normalizarTelefone,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  GanhadorAdminView,
  MeuPremioView,
  SorteConfigView,
  toGanhadorAdmin,
  toGanhadorPublico,
  toMeuPremio,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import {
  PremioTravado,
  RodadaTravada,
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAleatorioService } from 'src/associado-sorte/services/sorte-aleatorio.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { baseTag } from 'src/shared/log.util';

const TENTATIVAS_DE_CODIGO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Ganhadores: criação (com baixa de estoque), entrega e consulta. */
@Injectable()
export class SorteGanhadoresService {
  private readonly logger = new Logger(SorteGanhadoresService.name);

  constructor(
    private readonly repository: SorteGanhadoresRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly aleatorio: SorteAleatorioService,
    private readonly creditos: SorteCreditosService,
    private readonly config: SorteConfigService,
  ) {}

  /**
   * Cria o ganhador (rodada) ou o pedido (compra na loja, `rodada: null`) e
   * baixa UMA unidade do estoque na mesma transação, com o movimento
   * `SAIDA_GANHADOR`. Exige o prêmio travado (e a rodada, quando houver) e
   * `premio.estoque > 0`. Atualiza `premio.estoque` em memória.
   */
  async registrar(
    tx: SorteTx,
    params: {
      rodada: RodadaTravada | null;
      premio: PremioTravado;
      userId: number;
      baseOrigin: string;
      creditosGastos: number;
    },
  ): Promise<SorteGanhador> {
    const { rodada, premio } = params;
    if (premio.estoque <= 0) {
      throw erro409('ESGOTADO', 'As unidades deste prêmio acabaram');
    }

    const ganhador = await tx.criarGanhador({
      rodadaId: rodada?.id ?? null,
      premioId: premio.id,
      userId: params.userId,
      baseOrigin: params.baseOrigin,
      codigo: await this.gerarCodigoUnico(tx),
      origem: rodada ? rodada.mecanica : SorteGanhadorOrigem.LOJA,
      creditosGastos: params.creditosGastos,
    });

    const estoqueApos = premio.estoque - 1;
    await tx.atualizarEstoque(premio.id, estoqueApos);
    await tx.criarMovimentoEstoque({
      premioId: premio.id,
      tipo: SorteEstoqueMovimentoTipo.SAIDA_GANHADOR,
      quantidade: -1,
      estoqueApos,
      motivo: rodada
        ? `Ganhador ${ganhador.codigo} (rodada #${rodada.id})`
        : `Pedido ${ganhador.codigo} (Loja da Sorte)`,
      rodadaId: rodada?.id ?? null,
      ganhadorId: ganhador.id,
    });
    premio.estoque = estoqueApos;
    return ganhador;
  }

  private async gerarCodigoUnico(tx: SorteTx): Promise<string> {
    for (let i = 0; i < TENTATIVAS_DE_CODIGO; i++) {
      const codigo = gerarCodigo(this.aleatorio.inteiro);
      if (!(await tx.existeCodigo(codigo))) return codigo;
    }
    throw new Error('Não foi possível gerar um código único de prêmio');
  }

  /** Fim da carência do associado, ou `null` se pode ganhar. */
  async emCarenciaAte(
    userId: number,
    config: SorteConfigView,
    agora: Date,
  ): Promise<Date | null> {
    if (config.carenciaDias <= 0) return null;
    const janela = config.carenciaDias * DIA_MS;
    const ultima = await this.repository.ultimaVitoriaComCarencia(
      userId,
      new Date(agora.getTime() - janela),
    );
    return ultima ? new Date(ultima.getTime() + janela) : null;
  }

  // --------------------------------------------------------------------- app

  async meusPremios(userId: number, baseOrigin: string) {
    const config = await this.config.exigirAtiva(baseOrigin);
    const ganhadores = await this.repository.listarDoAssociado(userId);
    return {
      serverNow: new Date(),
      data: ganhadores.map((g) => toMeuPremio(g, config.whatsappSuporte)),
    };
  }

  async meuPremio(
    id: number,
    userId: number,
    baseOrigin: string,
  ): Promise<{ serverNow: Date; premio: MeuPremioView }> {
    const config = await this.config.exigirAtiva(baseOrigin);
    const ganhador = await this.repository.buscarDoAssociado(id, userId);
    if (!ganhador) throw new NotFoundException('Prêmio não encontrado');
    return {
      serverNow: new Date(),
      premio: toMeuPremio(ganhador, config.whatsappSuporte),
    };
  }

  /** O ganhador confirma o WhatsApp de contato (o backend não tem telefone). */
  async confirmarContato(params: {
    id: number;
    userId: number;
    baseOrigin: string;
    telefone: string;
  }): Promise<{ serverNow: Date; premio: MeuPremioView }> {
    const telefone = normalizarTelefone(params.telefone);
    if (!telefone) {
      throw erro422(
        'TELEFONE_INVALIDO',
        'Informe o WhatsApp com DDD (ex.: 21 99999-8888)',
      );
    }
    const ganhador = await this.repository.buscarDoAssociado(
      params.id,
      params.userId,
    );
    if (!ganhador) throw new NotFoundException('Prêmio não encontrado');

    await this.repository.confirmarContato(ganhador.id, telefone, new Date());
    this.logger.log(
      `${baseTag(params.baseOrigin)} ganhador #${ganhador.id} confirmou o WhatsApp ${mascararTelefone(telefone)}`,
    );
    return this.meuPremio(params.id, params.userId, params.baseOrigin);
  }

  /** Lista pública ("Samuel F."), só se a base estiver configurada para exibir. */
  async ultimosPublicos(config: SorteConfigView, limite: number) {
    if (!config.exibirGanhadores) return [];
    const ganhadores = await this.repository.listarUltimos(
      config.baseOrigin,
      limite,
    );
    return ganhadores.map(toGanhadorPublico);
  }

  // ------------------------------------------------------------------ painel

  async listar(query: ListarGanhadoresQuery) {
    const busca = query.busca?.trim();
    const where: Prisma.SorteGanhadorWhereInput = {
      ...(query.situacao ? { situacao: query.situacao } : {}),
      ...(query.origem ? { origem: query.origem } : {}),
      ...(query.rodadaId ? { rodadaId: query.rodadaId } : {}),
      ...(query.baseOrigin ? { baseOrigin: query.baseOrigin } : {}),
      ...(query.de || query.ate
        ? {
            createdAt: {
              ...(query.de ? { gte: new Date(query.de) } : {}),
              ...(query.ate ? { lt: new Date(query.ate) } : {}),
            },
          }
        : {}),
      ...(busca
        ? {
            OR: [
              { codigo: { contains: busca.toUpperCase() } },
              { user: { name: { contains: busca } } },
            ],
          }
        : {}),
    };
    const { data, total } = await this.repository.listarAdmin({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map(toGanhadorAdmin),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  /**
   * Muda a situação da entrega e/ou a observação. Cancelar é definitivo e
   * pode devolver a unidade ao estoque e os créditos ao associado, na mesma
   * transação (ordem de trava: prêmio → carteira).
   */
  async atualizar(
    id: number,
    dto: AtualizarGanhadorDto,
    autor: SorteAutor,
  ): Promise<GanhadorAdminView> {
    const existente = await this.repository.buscar(id);
    if (!existente) throw new NotFoundException('Ganhador não encontrado');

    const cancelando =
      dto.situacao === SorteGanhadorSituacao.CANCELADO &&
      existente.situacao !== SorteGanhadorSituacao.CANCELADO;
    if (!cancelando && (dto.devolverAoEstoque || dto.estornarCreditos)) {
      throw new BadRequestException(
        'Devolução de estoque/créditos só vale ao cancelar o ganhador',
      );
    }

    await this.uow.executar(async (tx) => {
      const premio = cancelando
        ? await tx.travarPremio(existente.premioId)
        : null;
      const estornar =
        cancelando && !!dto.estornarCreditos && existente.creditosGastos > 0;
      const carteira = estornar
        ? await tx.travarCarteira(existente.userId)
        : null;

      const atual = await tx.buscarGanhador(id);
      if (!atual) throw new NotFoundException('Ganhador não encontrado');
      const agora = new Date();

      const mudaSituacao =
        dto.situacao !== undefined && dto.situacao !== atual.situacao;
      if (mudaSituacao && atual.situacao === SorteGanhadorSituacao.CANCELADO) {
        throw erro409(
          'GANHADOR_CANCELADO',
          'Este ganhador foi cancelado e não pode mudar de situação',
        );
      }

      const dados: Prisma.SorteGanhadorUncheckedUpdateInput = {};
      if (dto.observacao !== undefined) {
        dados.observacao = dto.observacao?.trim() || null;
      }
      if (mudaSituacao) {
        dados.situacao = dto.situacao;
        dados.entregueEm =
          dto.situacao === SorteGanhadorSituacao.ENTREGUE ? agora : null;
      }

      if (mudaSituacao && dto.situacao === SorteGanhadorSituacao.CANCELADO) {
        dados.canceladoEm = agora;
        if (dto.devolverAoEstoque && premio) {
          const estoqueApos = premio.estoque + 1;
          await tx.atualizarEstoque(premio.id, estoqueApos);
          await tx.criarMovimentoEstoque({
            premioId: premio.id,
            tipo: SorteEstoqueMovimentoTipo.ESTORNO,
            quantidade: 1,
            estoqueApos,
            motivo: `Ganhador ${atual.codigo} cancelado`,
            rodadaId: atual.rodadaId,
            ganhadorId: atual.id,
            autorId: autor.id,
            autorNome: autor.nome,
          });
          dados.estoqueDevolvido = true;
        }
        if (carteira) {
          await this.creditos.lancar(tx, carteira, {
            tipo: SorteLancamentoTipo.ESTORNO,
            valor: atual.creditosGastos,
            baseOrigin: atual.baseOrigin,
            rodadaId: atual.rodadaId,
            descricao: `Prêmio ${atual.codigo} cancelado`,
            autor,
          });
        }
      }

      if (Object.keys(dados).length > 0) {
        await tx.atualizarGanhador(id, dados);
      }
    });

    if (dto.situacao && dto.situacao !== existente.situacao) {
      this.logger.log(
        `${baseTag(existente.baseOrigin)} ganhador #${id}: ${existente.situacao} → ${dto.situacao} por ${autor.nome ?? `#${autor.id}`}`,
      );
    }
    const atualizado = await this.repository.buscar(id);
    return toGanhadorAdmin(atualizado!);
  }

  async listarDaRodada(rodadaId: number): Promise<GanhadorAdminView[]> {
    return (await this.repository.listarDaRodada(rodadaId)).map(
      toGanhadorAdmin,
    );
  }
}

/** Mecânicas em que a carência se aplica (vitrine é troca direta). */
export function mecanicaTemCarencia(mecanica: SorteMecanica): boolean {
  return (
    mecanica === SorteMecanica.SORTEIO || mecanica === SorteMecanica.CORRIDA
  );
}
