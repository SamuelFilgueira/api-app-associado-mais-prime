import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from 'src/database/prisma.service';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  CpfsDaPlanilha,
  corrigirTextoUtf8,
  selecionarDestinatarios,
} from 'src/notifications/domain/planilha-cpf';
import {
  ConteudoDoDisparo,
  EstadoDoDisparo,
  chaveDeConteudo,
} from 'src/notifications/domain/push-disparo';
import { SendMarketingNotificationDto } from 'src/notifications/dto/send-marketing-notification.dto';
import { SituacaoCadastroNotificationData } from 'src/notifications/dto/send-situacao-cadastro-notification.dto';
import { lerCpfsDaPlanilha } from 'src/notifications/helpers/planilha-cpf.leitor';
import {
  ContextoDoPedido,
  TRAVA_DE_CRIACAO_MS,
  disparoEmAndamento,
} from 'src/notifications/services/marketing-disparo.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { PushDisparoService } from 'src/notifications/services/push-disparo.service';

/**
 * Resposta da rota. Os campos são os de sempre; como o envio agora acontece
 * depois da resposta:
 *  - `sentCount` = destinatários selecionados (pushes que entraram na fila);
 *  - `skippedCount` = CPFs que ficaram de fora da seleção;
 *  - `cpfsComFalhaEnvio` vem vazio (a falha de envio só é conhecida depois;
 *    fica em `PushEntrega` e na contagem final do histórico de disparos).
 */
export interface SituacaoCadastroResultado {
  sentCount: number;
  skippedCount: number;
  resumo: {
    totalLinhasPlanilha: number;
    cpfsValidos: number;
    cpfsInvalidos: string[];
    cpfsDuplicadosRemovidos: number;
    cpfsNaoEncontrados: string[];
    cpfsInativos: string[];
    cpfsSemToken: string[];
    cpfsComFalhaEnvio: string[];
  };
  disparoId: number;
  estado: EstadoDoDisparo;
  repetido?: true;
}

export interface PedidoPorPlanilha {
  arquivo: Buffer;
  title: string;
  body: string;
  /** Campo `data` do multipart: string JSON opcional. */
  data?: string;
}

/**
 * Push em massa para os CPFs de uma planilha Excel (mudança de situação no
 * cadastro — ex.: Ativo → Inadimplente). Sem filtro de opt-in de marketing:
 * é aviso de cadastro, não promoção.
 *
 * Segue o mesmo desenho do marketing: a requisição lê a planilha, resolve
 * os destinatários, cria o disparo com uma entrega por destinatário e
 * enfileira os lotes. A mesma planilha com o mesmo texto, enviada duas
 * vezes em seguida, é UM disparo.
 */
@Injectable()
export class SituacaoCadastroNotificationService {
  private readonly logger = new Logger(
    SituacaoCadastroNotificationService.name,
  );

  private static readonly MAX_CPFS = 10000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PushGateway,
    private readonly audit: MarketingNotificationAuditService,
    private readonly disparos: PushDisparoService,
    private readonly trava: TravaService,
    private readonly idempotencia: IdempotenciaService,
  ) {}

  /** Corrige acentuação que chegou com encoding errado (latin1/cp1252). */
  corrigirTextoUtf8(texto: string): string {
    return corrigirTextoUtf8(texto);
  }

  /**
   * Parseia o campo `data` (string JSON do multipart) no mesmo formato
   * aceito pela rota de marketing. Sem `data`, o padrão leva o associado
   * à tela de boletos do app (financeiro).
   */
  parseDataPayload(raw?: string): SituacaoCadastroNotificationData {
    if (!raw || !raw.trim()) {
      return { type: 'internal_route', screen: 'financeiro' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('O campo "data" não é um JSON válido');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException('O campo "data" deve ser um objeto JSON');
    }

    const data = parsed as SituacaoCadastroNotificationData;
    if (!data.type) {
      data.type = data.screen ? 'internal_route' : 'situacao_cadastro';
    }

    // Corrige mojibake também nos valores de texto do payload extra
    for (const chave of Object.keys(data)) {
      if (typeof data[chave] === 'string') {
        data[chave] = corrigirTextoUtf8(data[chave]);
      }
    }

    return data;
  }

  /** `POST /notifications/admin/situacao-cadastro`. */
  dispararPorPlanilha(
    pedido: PedidoPorPlanilha,
    contexto: ContextoDoPedido,
  ): Promise<SituacaoCadastroResultado> {
    if (!contexto.adminUserId) return this.disparar(pedido, undefined);
    return this.idempotencia.executar(
      {
        userId: contexto.adminUserId,
        escopo: 'painel.situacao-cadastro.disparar',
        chave: contexto.chaveDeIdempotencia,
        corpo: {
          title: pedido.title,
          body: pedido.body,
          data: pedido.data ?? null,
          arquivo: createHash('sha256').update(pedido.arquivo).digest('hex'),
        },
      },
      () => this.disparar(pedido, contexto.adminUserId),
    );
  }

  private async disparar(
    pedido: PedidoPorPlanilha,
    adminUserId: number | undefined,
  ): Promise<SituacaoCadastroResultado> {
    const titulo = corrigirTextoUtf8(pedido.title);
    const corpo = corrigirTextoUtf8(pedido.body);
    const dados = this.parseDataPayload(pedido.data);
    const registrar = () =>
      this.audit.createRequestAudit(
        adminUserId,
        {
          title: titulo,
          body: corpo,
          data: dados,
        } as unknown as SendMarketingNotificationDto,
        { tipo: 'SITUACAO_CADASTRO' },
      );

    let extracao: CpfsDaPlanilha;
    try {
      extracao = await lerCpfsDaPlanilha(
        pedido.arquivo,
        SituacaoCadastroNotificationService.MAX_CPFS,
      );
    } catch (erro) {
      // Planilha recusada também fica no histórico do painel, como falha.
      await this.audit.markFailure(
        await registrar(),
        erro instanceof Error ? erro.message : 'Erro desconhecido',
      );
      throw erro;
    }

    const usuarios = await this.prisma.user.findMany({
      where: { cpf: { in: extracao.cpfs } },
      select: { id: true, cpf: true, isActive: true, expoPushToken: true },
    });
    const selecao = selecionarDestinatarios(
      extracao.cpfs,
      usuarios,
      (token): token is string => this.gateway.tokenValido(token),
    );
    const ignorados =
      selecao.cpfsNaoEncontrados.length +
      selecao.cpfsInativos.length +
      selecao.cpfsSemToken.length;

    this.logger.log(
      `[SITUACAO-CADASTRO] Planilha: ${extracao.totalLinhas} linhas, ${extracao.cpfs.length} CPFs válidos, ` +
        `${extracao.cpfsInvalidos.length} inválidos, ${extracao.duplicadosRemovidos} duplicados; ` +
        `${selecao.destinatarios.length} destinatário(s), ${ignorados} fora da seleção`,
    );

    const conteudo: ConteudoDoDisparo = {
      tipo: 'SITUACAO_CADASTRO',
      titulo,
      corpo,
      dados,
      userIds: selecao.destinatarios.map((d) => d.userId),
    };
    const fonte = this.disparos.fonteFixa(selecao.destinatarios, ignorados);

    const criacao = await this.trava.tentar(
      `push-disparo:${chaveDeConteudo(conteudo)}`,
      TRAVA_DE_CRIACAO_MS,
      async () => {
        const repetido = await this.disparos.buscarRepetido(
          conteudo,
          new Date(),
        );
        if (repetido) return this.disparos.retomar(repetido, fonte);

        return this.disparos.criar(
          {
            tipo: 'SITUACAO_CADASTRO',
            titulo,
            corpo,
            dados,
            marketingAuditLogId: await registrar(),
          },
          fonte,
        );
      },
    );
    if (!criacao.executou) throw disparoEmAndamento();

    return {
      sentCount: selecao.destinatarios.length,
      skippedCount: ignorados,
      resumo: {
        totalLinhasPlanilha: extracao.totalLinhas,
        cpfsValidos: extracao.cpfs.length,
        cpfsInvalidos: extracao.cpfsInvalidos,
        cpfsDuplicadosRemovidos: extracao.duplicadosRemovidos,
        cpfsNaoEncontrados: selecao.cpfsNaoEncontrados,
        cpfsInativos: selecao.cpfsInativos,
        cpfsSemToken: selecao.cpfsSemToken,
        cpfsComFalhaEnvio: [],
      },
      disparoId: criacao.valor.disparoId,
      estado: criacao.valor.estado,
      ...(criacao.valor.repetido ? { repetido: true as const } : {}),
    };
  }
}
