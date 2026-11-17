import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';
import { SorteLancamentoTipo } from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  erro409,
  erro422,
  erro503,
} from 'src/associado-sorte/helpers/sorte-erros';
import { Semaforo } from 'src/associado-sorte/helpers/sorte.helpers';
import {
  SorteConfigView,
  toMeuPremio,
  toProdutoLoja,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import {
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteNotificacoesAdminService } from 'src/associado-sorte/services/sorte-notificacoes-admin.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';
import { baseTag } from 'src/shared/log.util';

const ERROS_DE_CONTENCAO = ['P2028', 'P2034'];

/**
 * Loja da Sorte (seção 2.5): compra direta de produto com créditos. É a
 * transação da vitrine do piloto sem rodada: trava o PRÊMIO e depois a
 * CARTEIRA; confere estoque, limite por associado e saldo com as linhas
 * travadas; registra o pedido (ganhador `LOJA`), baixa o estoque com
 * movimento, debita `COMPRA_LOJA` e cria as notificações do painel.
 * E-mail e push saem depois do commit e nunca desfazem a compra.
 */
@Injectable()
export class SorteLojaService {
  private readonly logger = new Logger(SorteLojaService.name);

  /** Limita as transações de compra abertas ao mesmo tempo (pool do Prisma). */
  private readonly semaforo = new Semaforo(
    associadoSorteConfig().compraConcorrenciaMaxima,
  );

  constructor(
    private readonly rateLimit: SorteRateLimitService,
    private readonly acesso: SorteAcessoService,
    private readonly premiosRepository: SortePremiosRepository,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly ganhadoresRepository: SorteGanhadoresRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly creditos: SorteCreditosService,
    private readonly ganhadores: SorteGanhadoresService,
    private readonly notificacoesAdmin: SorteNotificacoesAdminService,
    private readonly notificacoes: SorteNotificacoesService,
    private readonly tentativas: SorteTentativaService,
  ) {}

  /** Vitrine: produtos na loja (esgotados aparecem com `esgotado: true`). */
  async listar(userId: number, baseOrigin: string) {
    await this.acesso.validar(userId, baseOrigin, { rota: 'loja' });
    const [produtos, compras, carteira] = await Promise.all([
      this.premiosRepository.listarLoja(),
      this.ganhadoresRepository.comprasPorProduto(userId),
      this.creditosRepository.buscarCarteira(userId),
    ]);
    const estoqueBaixo = associadoSorteConfig().estoqueBaixo;
    return {
      serverNow: new Date(),
      saldo: carteira?.saldo ?? 0,
      produtos: produtos.map((p) =>
        toProdutoLoja(p, compras.get(p.id) ?? 0, estoqueBaixo),
      ),
    };
  }

  async comprar(params: {
    premioId: number;
    userId: number;
    baseOrigin: string;
  }) {
    const { premioId, userId, baseOrigin } = params;
    let resultado: {
      ganhadorId: number;
      saldo: number;
      estoqueApos: number;
      notificacaoId: number;
      config: SorteConfigView;
    };
    try {
      await this.rateLimit.verificar('comprar', userId);
      const { config } = await this.acesso.validar(userId, baseOrigin, {
        registrarTentativa: false,
      });
      // Recusa rápida: leitura simples, sem transação nem trava.
      await this.recusaRapida(premioId);

      const liberar = await this.semaforo.adquirir();
      try {
        // Pode ter esgotado enquanto esperava a vez.
        await this.recusaRapida(premioId);
        await this.creditosRepository.garantirCarteira(userId, baseOrigin);
        const r = await this.uow.executar((tx) =>
          this.comprarNaTransacao(tx, { premioId, userId, baseOrigin, config }),
        );
        resultado = { ...r, config };
      } finally {
        liberar();
      }
    } catch (erro) {
      this.tentativas.registrarErro({
        userId,
        baseOrigin,
        acao: 'COMPRAR',
        erro,
        contexto: { premioId },
      });
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        ERROS_DE_CONTENCAO.includes(erro.code)
      ) {
        throw erro503('Muita gente comprando ao mesmo tempo. Tente de novo.');
      }
      throw erro;
    }

    this.logger.log(
      `${baseTag(baseOrigin)} associado #${userId} comprou o produto #${premioId} na Loja da Sorte (pedido #${resultado.ganhadorId}, estoque ${resultado.estoqueApos})`,
    );

    // Depois do commit e sem segurar a resposta.
    this.notificacoesAdmin
      .enfileirarEmailRetirada(resultado.notificacaoId)
      .catch((erro: Error) =>
        this.logger.error(
          `${baseTag(baseOrigin)} falha ao enfileirar o e-mail do pedido #${resultado.ganhadorId}: ${erro.message}`,
        ),
      );
    this.notificacoes
      .avisarGanhadores([resultado.ganhadorId])
      .catch((erro: Error) =>
        this.logger.error(`Falha ao avisar o comprador: ${erro.message}`),
      );

    const pedido = await this.ganhadoresRepository.buscar(resultado.ganhadorId);
    return {
      serverNow: new Date(),
      pedido: toMeuPremio(pedido!, resultado.config.whatsappSuporte),
      saldo: resultado.saldo,
    };
  }

  /** `PRODUTO_INDISPONIVEL` / `ESGOTADO` sem abrir transação. */
  private async recusaRapida(premioId: number): Promise<void> {
    const premio = await this.premiosRepository.buscar(premioId);
    if (!premio || !premio.naLoja || !premio.ativo) {
      throw new NotFoundException('Produto não encontrado na loja');
    }
    if (premio.estoque <= 0) {
      throw erro409('ESGOTADO', 'Este produto esgotou');
    }
  }

  /**
   * Transação curta: prêmio → carteira, revalidando tudo com as linhas
   * travadas. Sem chamada externa aqui dentro.
   */
  async comprarNaTransacao(
    tx: SorteTx,
    params: {
      premioId: number;
      userId: number;
      baseOrigin: string;
      config: SorteConfigView;
    },
  ): Promise<{
    ganhadorId: number;
    saldo: number;
    estoqueApos: number;
    notificacaoId: number;
  }> {
    const { premioId, userId, baseOrigin, config } = params;

    const premio = await tx.travarPremio(premioId);
    if (!premio || premio.excluido || !premio.ativo || !premio.naLoja) {
      throw new NotFoundException('Produto não encontrado na loja');
    }
    if (premio.estoque <= 0) {
      throw erro409('ESGOTADO', 'Este produto esgotou');
    }
    if (premio.custoCreditos < 1) {
      throw erro422('CUSTO_INVALIDO', 'Produto sem preço em créditos');
    }

    const carteira = await tx.travarCarteira(userId);
    if (!carteira) throw new NotFoundException('Carteira não encontrada');

    if (premio.limitePorAssociado > 0) {
      const compras = await tx.contarComprasDoProduto(premioId, userId);
      if (compras >= premio.limitePorAssociado) {
        throw erro409(
          'LIMITE_POR_ASSOCIADO',
          `Este produto tem limite de ${premio.limitePorAssociado} por associado`,
          { limitePorAssociado: premio.limitePorAssociado },
        );
      }
    }

    if (carteira.saldo < premio.custoCreditos) {
      throw erro422(
        'CREDITOS_INSUFICIENTES',
        'Você não tem créditos suficientes',
        { saldo: carteira.saldo, necessario: premio.custoCreditos },
      );
    }

    const ganhador = await this.ganhadores.registrar(tx, {
      rodada: null,
      premio,
      userId,
      baseOrigin,
      creditosGastos: premio.custoCreditos,
    });
    await this.creditos.lancar(tx, carteira, {
      tipo: SorteLancamentoTipo.COMPRA_LOJA,
      valor: -premio.custoCreditos,
      baseOrigin,
      descricao: premio.nome.slice(0, 200),
    });

    const notificacaoId = await this.notificacoesAdmin.registrarCompra(tx, {
      baseOrigin,
      ganhadorId: ganhador.id,
      codigo: ganhador.codigo,
      premio,
      config,
    });

    return {
      ganhadorId: ganhador.id,
      saldo: carteira.saldo,
      estoqueApos: premio.estoque,
      notificacaoId,
    };
  }
}
