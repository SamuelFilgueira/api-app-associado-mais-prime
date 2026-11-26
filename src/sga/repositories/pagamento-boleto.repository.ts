import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import type { RegistroDeEncargos } from 'src/sga/domain/boleto-encargos';

/** Evento do outbox gravado junto com `pago = true`. */
export const EVENTO_BOLETO_PAGO = 'boleto.pago';

/** O que o job repetível carregava no payload e agora fica na linha. */
export interface DadosDaVerificacao {
  baseOrigin?: string | null;
  codigoVeiculo?: string | null;
  codigoAssociado?: number | null;
  nomeAssociado?: string | null;
  telefoneAssociado?: string | null;
}

const SELECAO_DO_PAGAMENTO = {
  id: true,
  userVehicleId: true,
  nossoNumero: true,
  pago: true,
  pagoEm: true,
  boletoCriadoEm: true,
  updatedAt: true,
  reativadoEm: true,
  pagoNotificadoEm: true,
  suriNotificadoEm: true,
  proximaConsultaEm: true,
  verificacaoEncerradaEm: true,
  baseOrigin: true,
  codigoVeiculo: true,
  codigoAssociado: true,
  nomeAssociado: true,
  telefoneAssociado: true,
} as const;

export type PagamentoDoBoleto = Prisma.ReinspectionPaymentGetPayload<{
  select: typeof SELECAO_DO_PAGAMENTO;
}>;

/** Resultado de uma consulta de situação do boleto no SGA. */
export interface ConsultaDoBoleto {
  userVehicleId: number;
  nossoNumero: string;
  situacao: string;
  pago: boolean;
  agora: Date;
  /** `pagoEm` já gravado (reentrada): mantém a data da primeira detecção. */
  pagoEmAnterior?: Date | null;
  /** Usados só quando a linha ainda não existe (job antigo). */
  linhaDigitavel?: string | null;
  linkBoleto?: string | null;
  dados?: DadosDaVerificacao;
  debugId?: string;
}

/** Linha reservada pela varredura: ninguém mais a pega até `reservadaAte`. */
export type PagamentoReservado = PagamentoDoBoleto & { reservadaAte: Date };

/**
 * O banco pediu para refazer a transação: conflito de escrita no snapshot
 * (MariaDB 1020), deadlock (1213) ou o `P2034` do Prisma.
 */
function ehConflitoDeEscrita(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'P2034') return true;
  const mensagem = error instanceof Error ? error.message : '';
  return /Record has changed since last read|try restarting transaction/i.test(
    mensagem,
  );
}

/** Só os campos informados (não apaga com `null` o que já estava gravado). */
function informados(dados: DadosDaVerificacao | undefined) {
  if (!dados) return {};
  return {
    ...(dados.baseOrigin ? { baseOrigin: dados.baseOrigin } : {}),
    ...(dados.codigoVeiculo ? { codigoVeiculo: dados.codigoVeiculo } : {}),
    ...(dados.codigoAssociado
      ? { codigoAssociado: dados.codigoAssociado }
      : {}),
    ...(dados.nomeAssociado ? { nomeAssociado: dados.nomeAssociado } : {}),
    ...(dados.telefoneAssociado
      ? { telefoneAssociado: dados.telefoneAssociado }
      : {}),
  };
}

/**
 * `ReinspectionPayment`: o boleto de reativação e a verificação do seu
 * pagamento. A linha é a fonte da verdade da verificação por varredura
 * (`proximaConsultaEm` / `verificacaoEncerradaEm`) e dos marcadores do
 * pós-pagamento (`reativadoEm`, `pagoNotificadoEm`).
 */
@Injectable()
export class PagamentoBoletoRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Grava o boleto recém-criado (ou adotado). Com `verificacao`, a linha já
   * nasce na varredura (`proximaConsultaEm = agora`); sem ela, fica só o
   * registro (boleto sem `nosso_numero` ou sem código de veículo não tem
   * como ser verificado).
   *
   * LANÇA se a gravação falhar: sem a linha não há verificação de pagamento.
   */
  async registrarBoleto(params: {
    userVehicleId: number;
    reinspectionId?: number;
    nossoNumero: string | null;
    linhaDigitavel: string | null;
    linkBoleto: string | null;
    agora: Date;
    verificacao?: DadosDaVerificacao;
    /** Memória de cálculo dos encargos por atraso, quando a regra os cobra. */
    encargos?: RegistroDeEncargos;
  }): Promise<void> {
    const encargos = params.encargos
      ? { encargos: params.encargos as unknown as Prisma.InputJsonValue }
      : {};
    const varredura = params.verificacao
      ? {
          ...informados(params.verificacao),
          proximaConsultaEm: params.agora,
          verificacaoEncerradaEm: null,
        }
      : {};

    if (!params.nossoNumero) {
      await this.prisma.reinspectionPayment.create({
        data: {
          userVehicleId: params.userVehicleId,
          reinspectionId: params.reinspectionId ?? null,
          linhaDigitavel: params.linhaDigitavel,
          linkBoleto: params.linkBoleto,
          situacaoBoleto: 'CRIADO',
          boletoCriadoEm: params.agora,
          pago: false,
          ...encargos,
        },
      });
      return;
    }

    await this.prisma.reinspectionPayment.upsert({
      where: { nossoNumero: params.nossoNumero },
      update: {
        // Regravar um boleto conhecido (adoção repetida, retomada) não apaga
        // a linha digitável nem o link que já estavam gravados.
        ...(params.linhaDigitavel != null
          ? { linhaDigitavel: params.linhaDigitavel }
          : {}),
        ...(params.linkBoleto != null ? { linkBoleto: params.linkBoleto } : {}),
        situacaoBoleto: 'CRIADO',
        pago: false,
        pagoEm: null,
        ...(params.reinspectionId
          ? { reinspectionId: params.reinspectionId }
          : {}),
        ...varredura,
        ...encargos,
      },
      create: {
        userVehicleId: params.userVehicleId,
        reinspectionId: params.reinspectionId ?? null,
        nossoNumero: params.nossoNumero,
        linhaDigitavel: params.linhaDigitavel,
        linkBoleto: params.linkBoleto,
        situacaoBoleto: 'CRIADO',
        boletoCriadoEm: params.agora,
        pago: false,
        ...varredura,
        ...encargos,
      },
    });
  }

  buscarPorNossoNumero(nossoNumero: string): Promise<PagamentoDoBoleto | null> {
    return this.prisma.reinspectionPayment.findUnique({
      where: { nossoNumero },
      select: SELECAO_DO_PAGAMENTO,
    });
  }

  /**
   * Grava o resultado de uma consulta ao SGA. Quando o boleto está pago, o
   * evento `boleto.pago` entra no outbox NA MESMA transação: ou ficam os
   * dois, ou nenhum. O evento tem chave única (`nossoNumero`), então regravar
   * `pago = true` nas reentradas não gera um segundo aviso.
   *
   * `pagoEm` guarda a primeira detecção. LANÇA se a gravação falhar.
   */
  async gravarConsulta(params: ConsultaDoBoleto): Promise<void> {
    // Duas verificações do mesmo boleto ao mesmo tempo (repetível duplicado,
    // reserva vencida): o MariaDB recusa a segunda escrita com "Record has
    // changed since last read ... try restarting transaction". A transação
    // é só esta gravação, então refazê-la é seguro.
    for (let tentativa = 1; ; tentativa++) {
      try {
        await this.gravarConsultaEmTransacao(params);
        return;
      } catch (error) {
        if (tentativa >= 3 || !ehConflitoDeEscrita(error)) throw error;
      }
    }
  }

  private async gravarConsultaEmTransacao(
    params: ConsultaDoBoleto,
  ): Promise<void> {
    const dados = informados(params.dados);
    await this.prisma.$transaction(async (tx) => {
      await tx.reinspectionPayment.upsert({
        where: { nossoNumero: params.nossoNumero },
        update: {
          situacaoBoleto: params.situacao,
          pago: params.pago,
          pagoEm: params.pago ? (params.pagoEmAnterior ?? params.agora) : null,
          ...dados,
        },
        create: {
          userVehicleId: params.userVehicleId,
          nossoNumero: params.nossoNumero,
          linhaDigitavel: params.linhaDigitavel ?? null,
          linkBoleto: params.linkBoleto ?? null,
          situacaoBoleto: params.situacao,
          boletoCriadoEm: params.agora,
          pago: params.pago,
          pagoEm: params.pago ? params.agora : null,
          ...dados,
        },
      });

      if (params.pago) {
        await this.outbox.registrar(tx, {
          tipo: EVENTO_BOLETO_PAGO,
          chave: params.nossoNumero,
          base: params.dados?.baseOrigin ?? null,
          payload: {
            nossoNumero: params.nossoNumero,
            ...(params.debugId ? { debugId: params.debugId } : {}),
          },
        });
      }
    });
  }

  /**
   * Reserva um lote de boletos com a consulta vencida. `FOR UPDATE SKIP
   * LOCKED` dentro de uma transação curta: duas varreduras simultâneas nunca
   * pegam a mesma linha. A reserva empurra `proximaConsultaEm` para a frente
   * na mesma transação; o processamento acontece FORA dela, e quem processa
   * grava depois o próximo horário de verdade (ou encerra a verificação).
   */
  async reservarLote(params: {
    agora: Date;
    limite: number;
    reservaMs: number;
  }): Promise<PagamentoReservado[]> {
    const reservadaAte = new Date(params.agora.getTime() + params.reservaMs);

    const linhas = await this.prisma.$transaction(
      async (tx) => {
        const vencidas = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM ReinspectionPayment
           WHERE verificacaoEncerradaEm IS NULL
             AND proximaConsultaEm IS NOT NULL
             AND proximaConsultaEm <= ${params.agora}
           ORDER BY proximaConsultaEm, id
           LIMIT ${params.limite}
           FOR UPDATE SKIP LOCKED`;
        if (vencidas.length === 0) return [];

        const ids = vencidas.map((linha) => Number(linha.id));
        await tx.reinspectionPayment.updateMany({
          where: { id: { in: ids } },
          data: { proximaConsultaEm: reservadaAte },
        });
        return tx.reinspectionPayment.findMany({
          where: { id: { in: ids } },
          orderBy: { id: 'asc' },
          select: SELECAO_DO_PAGAMENTO,
        });
      },
      { timeout: 10_000 },
    );

    return linhas.map((linha) => ({ ...linha, reservadaAte }));
  }

  /** Próxima consulta de um boleto que segue em aberto. */
  async reagendar(id: number, proximaConsultaEm: Date): Promise<boolean> {
    const { count } = await this.prisma.reinspectionPayment.updateMany({
      where: { id, verificacaoEncerradaEm: null },
      data: { proximaConsultaEm },
    });
    return count === 1;
  }

  /**
   * Encerra a verificação (pago e reativado, cancelado/excluído ou idade
   * máxima). `false` = já estava encerrada, ou a linha não existe.
   */
  async encerrar(nossoNumero: string, agora: Date): Promise<boolean> {
    const { count } = await this.prisma.reinspectionPayment.updateMany({
      where: { nossoNumero, verificacaoEncerradaEm: null },
      data: { verificacaoEncerradaEm: agora },
    });
    return count === 1;
  }

  /** Marca que o SGA aceitou a reativação do veículo (uma única vez). */
  async marcarReativado(nossoNumero: string, agora: Date): Promise<boolean> {
    const { count } = await this.prisma.reinspectionPayment.updateMany({
      where: { nossoNumero, reativadoEm: null },
      data: { reativadoEm: agora },
    });
    return count === 1;
  }

  /**
   * Reivindica o envio do e-mail de "boleto pago": só o primeiro chamador
   * recebe `true`. Quem recebe envia; se o envio falhar, devolve o marcador
   * com `devolverAvisoPorEmail`.
   */
  async reivindicarAvisoPorEmail(id: number, agora: Date): Promise<boolean> {
    const { count } = await this.prisma.reinspectionPayment.updateMany({
      where: { id, pagoNotificadoEm: null },
      data: { pagoNotificadoEm: agora },
    });
    return count === 1;
  }

  async devolverAvisoPorEmail(id: number, marcadoEm: Date): Promise<void> {
    await this.prisma.reinspectionPayment.updateMany({
      where: { id, pagoNotificadoEm: marcadoEm },
      data: { pagoNotificadoEm: null },
    });
  }

  /**
   * Memória de cálculo gravada com um boleto que ESTA API gerou (`null` se o
   * boleto não é nosso ou saiu sem encargos). Serve para o atraso não
   * recomeçar do zero quando o boleto em aberto já é um de reativação.
   */
  async encargosDoBoleto(nossoNumero: string): Promise<unknown> {
    const linha = await this.prisma.reinspectionPayment.findUnique({
      where: { nossoNumero },
      select: { encargos: true },
    });
    return linha?.encargos ?? null;
  }

  /**
   * Marcador do WhatsApp de boleto pago, no mesmo molde do e-mail: só um
   * chamador o reivindica; quem falha por instabilidade devolve.
   */
  async reivindicarAvisoPorWhatsapp(id: number, agora: Date): Promise<boolean> {
    const { count } = await this.prisma.reinspectionPayment.updateMany({
      where: { id, suriNotificadoEm: null },
      data: { suriNotificadoEm: agora },
    });
    return count === 1;
  }

  async devolverAvisoPorWhatsapp(id: number, marcadoEm: Date): Promise<void> {
    await this.prisma.reinspectionPayment.updateMany({
      where: { id, suriNotificadoEm: marcadoEm },
      data: { suriNotificadoEm: null },
    });
  }

  /**
   * Base do dono do veículo — para o job antigo, que não a trazia no payload,
   * e para a linha que ficou sem ela.
   */
  async baseDoDonoDoVeiculo(userVehicleId: number): Promise<string | null> {
    const veiculo = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { user: { select: { baseOrigin: true } } },
    });
    return veiculo?.user?.baseOrigin ?? null;
  }

  /** Dono do veículo do boleto: CPF e base. */
  async donoDoVeiculo(
    userVehicleId: number,
  ): Promise<{ cpf: string | null; baseOrigin: string | null } | null> {
    const veiculo = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { user: { select: { cpf: true, baseOrigin: true } } },
    });
    return veiculo?.user ?? null;
  }

  /** Chassi e placa do veículo, para o e-mail de boleto pago. */
  veiculoDoBoleto(
    userVehicleId: number,
  ): Promise<{ chassi: string; plate: string | null } | null> {
    return this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { chassi: true, plate: true },
    });
  }
}
