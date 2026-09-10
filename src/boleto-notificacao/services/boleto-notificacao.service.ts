import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { baseTag } from 'src/shared/log.util';
import {
  addDays,
  formatDateBR,
  formatDateISO,
  parseDateSga,
  startOfDay,
  toUtcDateOnly,
} from 'src/shared/date.util';
import {
  BoletoNotificacaoConfigService,
  TIPOS_MENSAGEM,
  TipoMensagem,
} from 'src/boleto-notificacao/config/boleto-notificacao.config';
import {
  calcularDataAlvo,
  mascararCpf,
  mesPorExtenso,
  normalizarCpf,
  primeiroNome,
  renderizarMensagem,
  TokensMensagem,
} from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';
import { SgaBoletoPeriodoClient } from 'src/boleto-notificacao/services/sga-boleto-periodo.client';
import { SgaBoletoPeriodo } from 'src/boleto-notificacao/interfaces/sga-boleto-periodo.interface';
import { SituacaoBoletoSga } from 'src/boleto-notificacao/enums/situacao-boleto-sga.enum';

export const JOB_EXECUTAR_ROTINA = 'executar-rotina';
export const JOB_VERIFICAR_RECEIPTS = 'verificar-receipts';

export interface ExecutarRotinaOptions {
  dataReferencia?: Date;
  tenants?: string[];
  tipos?: TipoMensagem[];
  dryRun?: boolean;
  origem?: 'AGENDADA' | 'MANUAL';
}

export interface MetricasMomento {
  totalRegistrosSga: number;
  totalPaginasSga: number;
  totalBoletosElegiveis: number;
  totalAssociados: number;
  totalSemUsuario: number;
  totalSemToken: number;
  totalIdempotentes: number;
  totalDuplicadosUsuario: number;
  totalEnfileirados: number;
  totalEnviados: number;
  totalFalhas: number;
  totalTokensInvalidos: number;
  coberturaElegiveis: number | null;
}

export interface ResultadoMomento {
  tenant: string;
  tipo: TipoMensagem;
  dataReferencia: string;
  dataAlvo: string;
  gatilho: boolean;
  dryRun: boolean;
  execucaoId: number | null;
  status: 'PULADA' | 'CONCLUIDA' | 'FALHA' | 'DRY_RUN';
  origemDados?: 'SGA' | 'MOCK';
  metricas: MetricasMomento;
  erro?: string;
  amostraDestinatarios?: Array<{
    codigoAssociado: number;
    cpf: string;
    userId: number;
    quantidadeBoletos: number;
    nossoNumero: string;
    vencimento: string;
    titulo: string;
    corpo: string;
  }>;
}

interface GrupoAssociado {
  codigoAssociado: number;
  cpf: string;
  /** Vencimento efetivo dos boletos do grupo (chave da idempotência). */
  vencimento: Date;
  boletos: SgaBoletoPeriodo[];
}

/** Janela de vencimento efetivo consultada por uma etapa da régua. */
interface JanelaEtapa {
  inicio: Date;
  fim: Date;
  descricao: string;
}

interface Destinatario extends GrupoAssociado {
  userId: number;
  expoPushToken: string;
  titulo: string;
  corpo: string;
}

function metricasVazias(): MetricasMomento {
  return {
    totalRegistrosSga: 0,
    totalPaginasSga: 0,
    totalBoletosElegiveis: 0,
    totalAssociados: 0,
    totalSemUsuario: 0,
    totalSemToken: 0,
    totalIdempotentes: 0,
    totalDuplicadosUsuario: 0,
    totalEnfileirados: 0,
    totalEnviados: 0,
    totalFalhas: 0,
    totalTokensInvalidos: 0,
    coberturaElegiveis: null,
  };
}

/**
 * Régua diária de notificações push do ciclo de cobrança
 * (D-5 / D0 / D+1 / D+5 / D+6 / D+20 — documento do gestor, v. 10/09/2026),
 * ancorada no vencimento EFETIVO (`data_vencimento`, que o SGA já prorroga
 * para o próximo dia útil em fds/feriado) e alimentada pelo endpoint
 * POST /listar/boleto-associado/periodo do SGA.
 */
@Injectable()
export class BoletoNotificacaoService {
  private readonly logger = new Logger(BoletoNotificacaoService.name);
  private readonly expo = new Expo();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: BoletoNotificacaoConfigService,
    private readonly sgaClient: SgaBoletoPeriodoClient,
    @InjectQueue(BOLETO_NOTIFICACAO_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Executa a rotina para todos os tenants × tipos solicitados. Falha em um
   * momento não interrompe os demais.
   */
  async executarRotina(
    options: ExecutarRotinaOptions = {},
  ): Promise<ResultadoMomento[]> {
    const config = this.configService.get();
    const dataReferencia = startOfDay(options.dataReferencia ?? new Date());
    const tenants = options.tenants?.length ? options.tenants : config.tenants;
    const tipos = options.tipos?.length ? options.tipos : TIPOS_MENSAGEM;
    const dryRun = options.dryRun === true;
    const origem = options.origem ?? 'MANUAL';

    this.logger.log(
      `[BOLETO-NOTIF] ▶ Rotina iniciada: referencia=${formatDateBR(dataReferencia)} tenants=[${tenants.join(',')}] tipos=[${tipos.join(',')}] dryRun=${dryRun} origem=${origem}`,
    );

    const resultados: ResultadoMomento[] = [];
    for (const tenant of tenants) {
      for (const tipo of tipos) {
        resultados.push(
          await this.processarMomento(
            tenant,
            tipo,
            dataReferencia,
            dryRun,
            origem,
          ),
        );
      }
    }

    const enviados = resultados.reduce(
      (acc, r) => acc + r.metricas.totalEnviados,
      0,
    );
    this.logger.log(
      `[BOLETO-NOTIF] ■ Rotina concluída: ${resultados.length} momento(s), ${enviados} push(es) enviados`,
    );

    return resultados;
  }

  /** Janelas de vencimento consultadas por etapa (apoio a testes/admin). */
  simularDatas(dataReferencia: Date) {
    const config = this.configService.get();
    const referencia = startOfDay(dataReferencia);
    return TIPOS_MENSAGEM.map((tipo) => {
      const janela = this.janelaDaEtapa(referencia, tipo);
      return {
        tipo,
        offset: config.offsets[tipo],
        dataAlvo: janela.descricao,
        // Régua v2: toda etapa é consultada todos os dias (o vencimento
        // efetivo pode cair em qualquer dia útil)
        gatilho: true,
      };
    });
  }

  /**
   * Janela de vencimento efetivo da etapa. Etapas pós-vencimento são de dia
   * único (hoje − offset); a DM5 cobre D-5..D-1, o que também implementa a
   * regra "boleto gerado depois de D-5 dispara quando aparecer, até D-1" —
   * a idempotência garante um único envio por associado × vencimento.
   */
  private janelaDaEtapa(referencia: Date, tipo: TipoMensagem): JanelaEtapa {
    const offsets = this.configService.get().offsets;
    if (tipo === 'DM5') {
      const inicio = addDays(referencia, 1);
      const fim = addDays(referencia, offsets.DM5);
      return {
        inicio,
        fim,
        descricao: `${formatDateBR(inicio)} a ${formatDateBR(fim)}`,
      };
    }
    const alvo = calcularDataAlvo(referencia, offsets[tipo]);
    return { inicio: alvo, fim: alvo, descricao: formatDateBR(alvo) };
  }

  /**
   * Processa um momento do ciclo (tenant × tipo) para a data de referência.
   */
  async processarMomento(
    tenant: string,
    tipo: TipoMensagem,
    dataReferencia: Date,
    dryRun: boolean,
    origem: 'AGENDADA' | 'MANUAL',
  ): Promise<ResultadoMomento> {
    const config = this.configService.get();
    const janela = this.janelaDaEtapa(dataReferencia, tipo);
    const tag = `[BOLETO-NOTIF]${baseTag(tenant)}[${tipo}]`;
    const metricas = metricasVazias();

    const base: ResultadoMomento = {
      tenant,
      tipo,
      dataReferencia: formatDateBR(dataReferencia),
      dataAlvo: janela.descricao,
      gatilho: true,
      dryRun,
      execucaoId: null,
      status: 'CONCLUIDA',
      metricas,
    };

    const execucaoId = dryRun
      ? null
      : (
          await this.prisma.boletoNotificacaoExecucao.create({
            data: {
              tenant,
              tipoMensagem: tipo,
              dataReferencia: toUtcDateOnly(dataReferencia),
              dataAlvo: toUtcDateOnly(janela.fim),
              status: 'EM_ANDAMENTO',
              origem,
              dryRun: false,
            },
            select: { id: true },
          })
        ).id;
    base.execucaoId = execucaoId;

    try {
      // 1. Consulta paginada ao SGA (ABERTO, vencimento efetivo dentro da janela)
      const consulta = await this.sgaClient.listarAbertosPorVencimento(
        tenant,
        janela.inicio,
        janela.fim,
      );
      base.origemDados = consulta.origem;
      metricas.totalRegistrosSga =
        consulta.totalRegistros || consulta.boletos.length;
      metricas.totalPaginasSga = consulta.paginasConsultadas;

      // 2. Filtro defensivo local (o SGA já filtra situação/data; aqui também
      //    entram os filtros da régua: tipo de boleto e, em D+6/D+20, contrato suspenso)
      const filtroTipos = config.codigosTipoBoleto;
      const filtroSuspenso =
        tipo === 'D6' || tipo === 'D20'
          ? config.situacoesContratoSuspenso.map((s) => s.toUpperCase())
          : [];
      const elegiveis = consulta.boletos.filter((b) => {
        // O SGA responde datas em yyyy-mm-dd (doc diz dd/mm/yyyy) — parser aceita ambos
        const vencimento = parseDateSga(b.dataVencimento);
        const situacaoOk = b.codigoSituacaoBoleto === SituacaoBoletoSga.ABERTO;
        const dataOk =
          !!vencimento &&
          vencimento >= janela.inicio &&
          vencimento <= janela.fim;
        const tipoOk =
          filtroTipos.length === 0 || filtroTipos.includes(b.codigoTipoBoleto);
        const suspensoOk =
          filtroSuspenso.length === 0 ||
          b.veiculos.some((v) =>
            filtroSuspenso.includes(
              String(v.situacao_veiculo ?? '')
                .trim()
                .toUpperCase(),
            ),
          );
        return situacaoOk && dataOk && tipoOk && suspensoOk;
      });
      if (elegiveis.length !== consulta.boletos.length) {
        this.logger.warn(
          `${tag} ${consulta.boletos.length - elegiveis.length} boleto(s) fora dos filtros da etapa (situação/data/tipo/suspenso) foram descartados`,
        );
      }
      metricas.totalBoletosElegiveis = elegiveis.length;

      // 3. Agrupa por associado × vencimento efetivo (1 push por grupo)
      const grupos = new Map<string, GrupoAssociado>();
      let semIdentificacao = 0;
      for (const boleto of elegiveis) {
        const cpf = normalizarCpf(boleto.cpf);
        const vencimento = parseDateSga(boleto.dataVencimento);
        if (boleto.codigoAssociado === null || !cpf || !vencimento) {
          semIdentificacao++;
          continue;
        }
        const chave = `${boleto.codigoAssociado}:${formatDateISO(vencimento)}`;
        const grupo = grupos.get(chave);
        if (grupo) {
          grupo.boletos.push(boleto);
        } else {
          grupos.set(chave, {
            codigoAssociado: boleto.codigoAssociado,
            cpf,
            vencimento,
            boletos: [boleto],
          });
        }
      }
      metricas.totalAssociados = grupos.size;
      if (semIdentificacao > 0) {
        this.logger.warn(
          `${tag} ${semIdentificacao} boleto(s) sem codigo_associado/cpf válido foram ignorados`,
        );
        metricas.totalSemUsuario += semIdentificacao;
      }

      if (grupos.size === 0) {
        this.logger.log(
          `${tag} nenhum boleto ABERTO com vencimento efetivo em ${base.dataAlvo}`,
        );
        return await this.finalizar(base, execucaoId, metricas, dryRun);
      }

      // 4. Usuários do app (CPF único na base local; respeita o tenant quando informado)
      const cpfs = Array.from(
        new Set(Array.from(grupos.values()).map((g) => g.cpf)),
      );
      const usuarios = await this.prisma.user.findMany({
        where: { cpf: { in: cpfs }, isActive: true },
        select: { id: true, cpf: true, baseOrigin: true, expoPushToken: true },
      });
      const usuarioPorCpf = new Map<string, (typeof usuarios)[number]>();
      let outroTenant = 0;
      for (const u of usuarios) {
        if (u.baseOrigin && u.baseOrigin !== tenant) {
          outroTenant++;
          continue;
        }
        usuarioPorCpf.set(u.cpf, u);
      }
      if (outroTenant > 0) {
        this.logger.warn(
          `${tag} ${outroTenant} usuário(s) com CPF do lote pertencem a outro tenant e foram ignorados`,
        );
      }

      // 5. Idempotência: já existe log para (tenant, associado, vencimento, tipo)?
      const listaGrupos = Array.from(grupos.values());
      const existentes = await this.prisma.boletoNotificacaoLog.findMany({
        where: {
          tenant,
          tipoMensagem: tipo,
          dataVencimentoOriginal: {
            in: Array.from(
              new Set(
                listaGrupos.map((g) => toUtcDateOnly(g.vencimento).getTime()),
              ),
            ).map((t) => new Date(t)),
          },
          codigoAssociado: {
            in: Array.from(new Set(listaGrupos.map((g) => g.codigoAssociado))),
          },
        },
        select: { codigoAssociado: true, dataVencimentoOriginal: true },
      });
      const jaNotificados = new Set(
        existentes.map(
          (e) =>
            `${e.codigoAssociado}:${e.dataVencimentoOriginal.toISOString().slice(0, 10)}`,
        ),
      );

      // 6. Classificação dos grupos
      const mensagem = config.mensagens[tipo];
      const destinatarios: Destinatario[] = [];
      const usuariosNoLote = new Set<string>();

      for (const grupo of grupos.values()) {
        const chaveGrupo = `${grupo.codigoAssociado}:${formatDateISO(grupo.vencimento)}`;
        if (jaNotificados.has(chaveGrupo)) {
          metricas.totalIdempotentes++;
          continue;
        }
        const usuario = usuarioPorCpf.get(grupo.cpf);
        if (!usuario) {
          metricas.totalSemUsuario++;
          continue;
        }
        if (
          !usuario.expoPushToken ||
          !Expo.isExpoPushToken(usuario.expoPushToken)
        ) {
          metricas.totalSemToken++;
          continue;
        }
        const chaveUsuario = `${usuario.id}:${formatDateISO(grupo.vencimento)}`;
        if (usuariosNoLote.has(chaveUsuario)) {
          metricas.totalDuplicadosUsuario++;
          continue;
        }
        usuariosNoLote.add(chaveUsuario);

        // Tokens da régua, extraídos do primeiro boleto do grupo
        const primeiroBoleto = grupo.boletos[0];
        const vencimentoBR = formatDateBR(grupo.vencimento);
        const valores: TokensMensagem = {
          nome: primeiroNome(primeiroBoleto?.nomeAssociado),
          placa:
            String(primeiroBoleto?.veiculos?.[0]?.placa ?? '').trim() ||
            'seu veículo',
          mes: mesPorExtenso(primeiroBoleto?.mesReferente),
          data: vencimentoBR.slice(0, 5),
          vencimento: vencimentoBR,
          quantidade: grupo.boletos.length,
        };
        destinatarios.push({
          ...grupo,
          userId: usuario.id,
          expoPushToken: usuario.expoPushToken,
          titulo: renderizarMensagem(mensagem.titulo, valores),
          corpo: renderizarMensagem(mensagem.corpo, valores),
        });
      }

      this.logger.log(
        `${tag} elegíveis=${metricas.totalBoletosElegiveis} associados=${metricas.totalAssociados} ` +
          `semUsuario=${metricas.totalSemUsuario} semToken=${metricas.totalSemToken} ` +
          `idempotentes=${metricas.totalIdempotentes} duplicadosUsuario=${metricas.totalDuplicadosUsuario} → a enviar=${destinatarios.length}`,
      );

      if (dryRun) {
        metricas.totalEnfileirados = destinatarios.length;
        metricas.coberturaElegiveis = this.cobertura(
          destinatarios.length,
          metricas.totalAssociados,
        );
        base.status = 'DRY_RUN';
        base.amostraDestinatarios = destinatarios.slice(0, 20).map((d) => ({
          codigoAssociado: d.codigoAssociado,
          cpf: mascararCpf(d.cpf),
          userId: d.userId,
          quantidadeBoletos: d.boletos.length,
          nossoNumero: d.boletos[0]?.nossoNumero ?? '',
          vencimento: formatDateBR(d.vencimento),
          titulo: d.titulo,
          corpo: d.corpo,
        }));
        return base;
      }

      // 7. Registra os logs (ENFILEIRADO) — a unique key barra concorrência
      const enfileirados: Array<{ logId: number; destinatario: Destinatario }> =
        [];
      for (const destinatario of destinatarios) {
        try {
          const log = await this.prisma.boletoNotificacaoLog.create({
            data: {
              execucaoId: execucaoId as number,
              tenant,
              codigoAssociado: destinatario.codigoAssociado,
              cpf: destinatario.cpf,
              userId: destinatario.userId,
              nossoNumero: destinatario.boletos[0]?.nossoNumero || null,
              quantidadeBoletos: destinatario.boletos.length,
              dataVencimentoOriginal: toUtcDateOnly(destinatario.vencimento),
              tipoMensagem: tipo,
              expoPushToken: destinatario.expoPushToken,
              statusEnvio: 'ENFILEIRADO',
              mensagemTitulo: destinatario.titulo,
              mensagemEnviada: destinatario.corpo,
            },
            select: { id: true },
          });
          enfileirados.push({ logId: log.id, destinatario });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            metricas.totalIdempotentes++; // outra execução concorrente já registrou
            continue;
          }
          throw error;
        }
      }
      metricas.totalEnfileirados = enfileirados.length;
      metricas.coberturaElegiveis = this.cobertura(
        enfileirados.length,
        metricas.totalAssociados,
      );

      // 8. Envio via Expo em lotes de até 100
      await this.enviarLotes(tag, tipo, enfileirados, metricas);

      // 9. Receipts assíncronos
      if (metricas.totalEnviados > 0) {
        await this.agendarVerificacaoReceipts(execucaoId as number);
      }

      return await this.finalizar(base, execucaoId, metricas, dryRun);
    } catch (error) {
      const mensagemErro =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${tag} ❌ falha: ${mensagemErro}`,
        error instanceof Error ? error.stack : undefined,
      );
      base.status = 'FALHA';
      base.erro = mensagemErro;
      if (execucaoId !== null) {
        await this.prisma.boletoNotificacaoExecucao
          .update({
            where: { id: execucaoId },
            data: {
              status: 'FALHA',
              erro: mensagemErro.slice(0, 2000),
              finalizadoEm: new Date(),
              ...this.metricasParaPersistir(metricas),
            },
          })
          .catch((e) =>
            this.logger.error(
              `${tag} falha ao registrar erro da execução: ${e.message}`,
            ),
          );
      }
      return base;
    }
  }

  private async enviarLotes(
    tag: string,
    tipo: TipoMensagem,
    enfileirados: Array<{ logId: number; destinatario: Destinatario }>,
    metricas: MetricasMomento,
  ): Promise<void> {
    if (enfileirados.length === 0) return;

    const messages: ExpoPushMessage[] = enfileirados.map(
      ({ destinatario }) => ({
        to: destinatario.expoPushToken,
        title: destinatario.titulo,
        body: destinatario.corpo,
        data: {
          // Deep-link reaproveitado do fluxo de push por CPF: abre a área financeira do app
          type: 'internal_route',
          screen: 'financeiro',
          origem: 'boleto_cobranca',
          tipoMensagem: tipo,
          dataVencimentoOriginal: formatDateISO(destinatario.vencimento),
          quantidadeBoletos: destinatario.boletos.length,
        },
        sound: 'default',
        priority: 'high',
        channelId: 'alerts_v2',
        _contentAvailable: true,
        mutableContent: true,
      }),
    );

    // chunkPushNotifications respeita o limite de 100 mensagens por requisição
    const chunks = this.expo.chunkPushNotifications(messages);
    let offset = 0;
    const historico: Array<{
      userId: number;
      expoPushToken: string;
      title: string;
      body: string;
      data: unknown;
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        for (let j = 0; j < tickets.length; j++) {
          const ticket = tickets[j];
          const { logId, destinatario } = enfileirados[offset + j];

          if (ticket.status === 'ok') {
            metricas.totalEnviados++;
            await this.prisma.boletoNotificacaoLog.update({
              where: { id: logId },
              data: { statusEnvio: 'ENVIADO', expoTicketId: ticket.id },
            });
            historico.push({
              userId: destinatario.userId,
              expoPushToken: destinatario.expoPushToken,
              title: destinatario.titulo,
              body: destinatario.corpo,
              data: chunk[j].data,
            });
          } else {
            const codigoErro = ticket.details?.error ?? 'TICKET_ERROR';
            const descricao =
              `${codigoErro}: ${ticket.message ?? 'erro desconhecido'}`.slice(
                0,
                255,
              );
            metricas.totalFalhas++;
            await this.prisma.boletoNotificacaoLog.update({
              where: { id: logId },
              data: { statusEnvio: 'FALHA', expoErro: descricao },
            });
            if (codigoErro === 'DeviceNotRegistered') {
              metricas.totalTokensInvalidos++;
              await this.invalidarToken(
                destinatario.userId,
                destinatario.expoPushToken,
                tag,
              );
            }
            this.logger.warn(
              `${tag} ticket com erro para user ${destinatario.userId}: ${descricao}`,
            );
          }
        }
      } catch (error) {
        const descricao =
          `SEND_ERROR: ${error?.message ?? 'erro desconhecido'}`.slice(0, 255);
        this.logger.error(
          `${tag} erro ao enviar lote ${i + 1}/${chunks.length}: ${descricao}`,
        );
        const ids = enfileirados
          .slice(offset, offset + chunk.length)
          .map((e) => e.logId);
        metricas.totalFalhas += ids.length;
        await this.prisma.boletoNotificacaoLog.updateMany({
          where: { id: { in: ids } },
          data: { statusEnvio: 'FALHA', expoErro: descricao },
        });
      }
      offset += chunk.length;
    }

    // Histórico do app (sino) — apenas os efetivamente enviados
    if (historico.length > 0) {
      try {
        await this.prisma.notification.createMany({
          data: historico.map((h) => ({
            userId: h.userId,
            expoPushToken: h.expoPushToken,
            title: h.title,
            body: h.body,
            data: h.data as Prisma.InputJsonValue,
            sentAt: new Date(),
          })),
        });
      } catch (error) {
        this.logger.error(
          `${tag} erro ao gravar histórico de notificações: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `${tag} envio concluído: ${metricas.totalEnviados} enviados, ${metricas.totalFalhas} falhas, ${metricas.totalTokensInvalidos} tokens inválidos (${chunks.length} lote(s))`,
    );
  }

  /** DeviceNotRegistered: o token está morto — limpa no usuário para não insistir. */
  async invalidarToken(
    userId: number,
    token: string,
    tag: string,
  ): Promise<void> {
    try {
      await this.prisma.user.updateMany({
        where: { id: userId, expoPushToken: token },
        data: { expoPushToken: null },
      });
      this.logger.warn(
        `${tag} token do user ${userId} marcado como inválido (DeviceNotRegistered) e removido`,
      );
    } catch (error) {
      this.logger.error(
        `${tag} falha ao invalidar token do user ${userId}: ${error.message}`,
      );
    }
  }

  private async agendarVerificacaoReceipts(execucaoId: number): Promise<void> {
    const delayMs = this.configService.get().receiptsDelayMinutos * 60_000;
    try {
      await this.queue.add(
        JOB_VERIFICAR_RECEIPTS,
        { execucaoId, tentativa: 1 },
        {
          delay: delayMs,
          jobId: `boleto-notificacao-receipts-${execucaoId}-1`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      this.logger.error(
        `[BOLETO-NOTIF] falha ao agendar verificação de receipts da execução #${execucaoId}: ${error.message}`,
      );
    }
  }

  private cobertura(numerador: number, denominador: number): number | null {
    if (denominador <= 0) return null;
    return Math.round((numerador / denominador) * 10000) / 10000;
  }

  private metricasParaPersistir(m: MetricasMomento) {
    return {
      totalRegistrosSga: m.totalRegistrosSga,
      totalPaginasSga: m.totalPaginasSga,
      totalBoletosElegiveis: m.totalBoletosElegiveis,
      totalAssociados: m.totalAssociados,
      totalSemUsuario: m.totalSemUsuario,
      totalSemToken: m.totalSemToken,
      totalIdempotentes: m.totalIdempotentes,
      totalDuplicadosUsuario: m.totalDuplicadosUsuario,
      totalEnfileirados: m.totalEnfileirados,
      totalEnviados: m.totalEnviados,
      totalFalhas: m.totalFalhas,
      totalTokensInvalidos: m.totalTokensInvalidos,
      coberturaElegiveis: m.coberturaElegiveis,
    };
  }

  private async finalizar(
    base: ResultadoMomento,
    execucaoId: number | null,
    metricas: MetricasMomento,
    dryRun: boolean,
  ): Promise<ResultadoMomento> {
    base.status = dryRun ? 'DRY_RUN' : 'CONCLUIDA';
    if (execucaoId !== null) {
      await this.prisma.boletoNotificacaoExecucao.update({
        where: { id: execucaoId },
        data: {
          status: 'CONCLUIDA',
          finalizadoEm: new Date(),
          ...this.metricasParaPersistir(metricas),
        },
      });
    }
    return base;
  }
}
