import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SorteNotificacaoAdmin } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  associadoSorteConfig,
  SORTE_EMAIL_RETIRADA_JOB,
} from 'src/associado-sorte/config/associado-sorte.config';
import { ListarNotificacoesQuery } from 'src/associado-sorte/dto/notificacao.dto';
import {
  SORTE_PRODUTO_TIPO_LABELS,
  SorteAutor,
  SorteNotificacaoAdminTipo,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { dataHoraBrasilia } from 'src/associado-sorte/helpers/sorte-cronograma.helper';
import {
  linkWhatsapp,
  mascararCpf,
  mascararTelefone,
  metaPaginacao,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  SorteConfigView,
  toNotificacaoAdmin,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteNotificacoesAdminRepository } from 'src/associado-sorte/repositories/sorte-notificacoes-admin.repository';
import {
  PremioTravado,
  SorteTx,
} from 'src/associado-sorte/repositories/sorte-transacao';
import {
  separarEmails,
  SorteConfigService,
} from 'src/associado-sorte/services/sorte-config.service';
import { MailService } from 'src/infra/mail/mail.service';
import { ASSOCIADO_SORTE_QUEUE } from 'src/queue/queue.module';
import { baseTag } from 'src/shared/log.util';

export interface EmailRetiradaJob {
  notificacaoId: number;
}

/**
 * Avisos para a equipe a cada compra na loja (seção 2.6): área de
 * Notificações do painel (gravada na transação da compra) e e-mail para
 * `emailNotificacoes` por um job com 3 tentativas, depois do commit.
 */
@Injectable()
export class SorteNotificacoesAdminService {
  private readonly logger = new Logger(SorteNotificacoesAdminService.name);

  constructor(
    private readonly repository: SorteNotificacoesAdminRepository,
    private readonly ganhadoresRepository: SorteGanhadoresRepository,
    private readonly config: SorteConfigService,
    private readonly mail: MailService,
    @InjectQueue(ASSOCIADO_SORTE_QUEUE) private readonly fila: Queue,
  ) {}

  /**
   * Na transação da compra (prêmio já travado e com o estoque baixado em
   * memória): NOVA_RETIRADA e, se for o caso, ESTOQUE_ESGOTADO/ESTOQUE_BAIXO.
   * Devolve o id da NOVA_RETIRADA (para o e-mail).
   */
  async registrarCompra(
    tx: SorteTx,
    params: {
      baseOrigin: string;
      ganhadorId: number;
      codigo: string;
      premio: PremioTravado;
      config: SorteConfigView;
    },
  ): Promise<number> {
    const { premio, codigo, baseOrigin } = params;
    const destinatarios = separarEmails(params.config.emailNotificacoes);
    const retirada = await tx.criarNotificacaoAdmin({
      baseOrigin,
      tipo: SorteNotificacaoAdminTipo.NOVA_RETIRADA,
      titulo: `Nova retirada: ${premio.nome}`.slice(0, 160),
      mensagem: `Pedido ${codigo} — ${premio.nome} (${SORTE_PRODUTO_TIPO_LABELS[premio.tipo]}, ${premio.custoCreditos} créditos). Chame o associado no WhatsApp para combinar a retirada.`,
      ganhadorId: params.ganhadorId,
      premioId: premio.id,
      emailDestinatarios: destinatarios.length
        ? destinatarios.join(', ').slice(0, 500)
        : null,
    });

    const { estoqueBaixo } = associadoSorteConfig();
    if (premio.estoque <= 0) {
      await tx.criarNotificacaoAdmin({
        baseOrigin,
        tipo: SorteNotificacaoAdminTipo.ESTOQUE_ESGOTADO,
        titulo: `Estoque esgotado: ${premio.nome}`.slice(0, 160),
        mensagem: `O produto "${premio.nome}" esgotou na Loja da Sorte. Dê entrada no estoque para voltar a vender.`,
        premioId: premio.id,
      });
    } else if (premio.estoque <= estoqueBaixo) {
      await tx.criarNotificacaoAdmin({
        baseOrigin,
        tipo: SorteNotificacaoAdminTipo.ESTOQUE_BAIXO,
        titulo: `Estoque baixo: ${premio.nome}`.slice(0, 160),
        mensagem: `Restam ${premio.estoque} unidade(s) de "${premio.nome}" na Loja da Sorte.`,
        premioId: premio.id,
      });
    }
    return retirada.id;
  }

  /** Enfileira o e-mail da retirada (depois do commit). */
  async enfileirarEmailRetirada(notificacaoId: number): Promise<void> {
    const notificacao = await this.repository.buscar(notificacaoId);
    if (!notificacao?.emailDestinatarios) return;
    await this.fila.add(
      SORTE_EMAIL_RETIRADA_JOB,
      { notificacaoId } satisfies EmailRetiradaJob,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  /**
   * Job `sorte-email-retirada`: monta e envia o e-mail. Lança em caso de
   * falha para o BullMQ tentar de novo (3 tentativas); registra o resultado
   * na notificação.
   */
  async enviarEmailRetirada(notificacaoId: number): Promise<void> {
    const notificacao = await this.repository.buscar(notificacaoId);
    if (!notificacao?.emailDestinatarios || notificacao.emailEnviadoEm) return;
    const destinatarios = separarEmails(notificacao.emailDestinatarios);
    const pedido = notificacao.ganhadorId
      ? await this.ganhadoresRepository.buscarParaEmail(notificacao.ganhadorId)
      : null;
    if (!pedido) {
      await this.repository.registrarEmail(notificacaoId, {
        emailErro: 'Pedido não encontrado',
      });
      return;
    }

    const painelUrl = associadoSorteConfig().painelUrl;
    try {
      await this.mail.sendSorteNovaRetiradaEmail(destinatarios, {
        produto: pedido.premio.nome,
        tipoProduto: SORTE_PRODUTO_TIPO_LABELS[pedido.premio.tipo],
        codigoPedido: pedido.codigo,
        creditos: pedido.creditosGastos,
        associadoNome: pedido.user.name,
        cpfMascarado: mascararCpf(pedido.user.cpf),
        telefoneMascarado: pedido.telefoneContato
          ? mascararTelefone(pedido.telefoneContato)
          : null,
        compradoEm: dataHoraBrasilia(pedido.createdAt),
        linkPainel: painelUrl
          ? `${painelUrl}/retiradas?busca=${encodeURIComponent(pedido.codigo)}`
          : null,
      });
      await this.repository.registrarEmail(notificacaoId, {
        emailEnviadoEm: new Date(),
        emailErro: null,
      });
      this.logger.log(
        `${baseTag(pedido.baseOrigin)} e-mail do pedido ${pedido.codigo} enviado para ${destinatarios.length} destinatário(s)`,
      );
    } catch (erro) {
      const mensagem = (erro as Error).message ?? String(erro);
      await this.repository
        .registrarEmail(notificacaoId, { emailErro: mensagem.slice(0, 300) })
        .catch(() => undefined);
      this.logger.warn(
        `${baseTag(pedido.baseOrigin)} falha ao enviar o e-mail do pedido ${pedido.codigo}: ${mensagem}`,
      );
      throw erro;
    }
  }

  // ------------------------------------------------------------------ painel

  async listar(query: ListarNotificacoesQuery) {
    const where: Prisma.SorteNotificacaoAdminWhereInput = {
      ...(query.baseOrigin ? { baseOrigin: query.baseOrigin } : {}),
      ...(query.tipo ? { tipo: query.tipo } : {}),
      ...(query.lida === 'true' ? { lidaEm: { not: null } } : {}),
      ...(query.lida === 'false' ? { lidaEm: null } : {}),
    };
    const { data, total } = await this.repository.listar({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const configs = new Map<string, SorteConfigView | null>();
    for (const base of new Set(data.map((n) => n.baseOrigin))) {
      configs.set(base, await this.config.obter(base).catch(() => null));
    }
    return {
      data: data.map((n) => this.view(n, configs.get(n.baseOrigin) ?? null)),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  async contarNaoLidas(baseOrigin?: string) {
    return { naoLidas: await this.repository.contarNaoLidas(baseOrigin) };
  }

  async marcarLida(id: number, autor: SorteAutor) {
    const n = await this.repository.buscar(id);
    if (!n) throw new NotFoundException('Notificação não encontrada');
    await this.repository.marcarLida(id, new Date(), autor);
    const atualizada = await this.repository.buscar(id);
    const config = await this.config.obter(n.baseOrigin).catch(() => null);
    return this.view(atualizada!, config);
  }

  async marcarTodas(autor: SorteAutor, baseOrigin?: string) {
    const marcadas = await this.repository.marcarTodas(
      new Date(),
      autor,
      baseOrigin,
    );
    return { marcadas };
  }

  private view(n: SorteNotificacaoAdmin, config: SorteConfigView | null) {
    const link =
      n.tipo === SorteNotificacaoAdminTipo.NOVA_RETIRADA && config
        ? linkWhatsapp(
            config.whatsappMarketing,
            `Associado da Sorte — ${n.titulo}. ${n.mensagem} (registrado em ${dataHoraBrasilia(n.createdAt)})`,
          )
        : null;
    return toNotificacaoAdmin(n, link);
  }
}
