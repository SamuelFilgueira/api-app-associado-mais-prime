import { Injectable } from '@nestjs/common';
import { ReinspectionBoletoStatus } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { RevistoriaParaBoleto } from 'src/sga/domain/boleto-resultado';

export type { RevistoriaParaBoleto } from 'src/sga/domain/boleto-resultado';

const SELECAO_DA_REVISTORIA = {
  id: true,
  status: true,
  codigoVeiculo: true,
  boletoStatus: true,
  boletoTentativas: true,
  boletoNossoNumero: true,
  boletoOrigem: true,
  boletoUltimaTentativaEm: true,
  boletoProximaTentativaEm: true,
  boletoRetryInicioEm: true,
  createdAt: true,
  updatedAt: true,
  userVehicle: {
    select: {
      id: true,
      chassi: true,
      plate: true,
      user: { select: { cpf: true, baseOrigin: true } },
    },
  },
} as const;

/**
 * Estado do boleto de reativação na revistoria (`Reinspection.boleto*`).
 *
 * Toda escrita aqui é `UPDATE ... WHERE <condição>` com a contagem de linhas
 * devolvida: quem chama sabe se a mudança de estado aconteceu ou se outra
 * tentativa chegou antes.
 */
@Injectable()
export class BoletoReativacaoRepository {
  constructor(private readonly prisma: PrismaService) {}

  carregar(reinspectionId: number): Promise<RevistoriaParaBoleto | null> {
    return this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: SELECAO_DA_REVISTORIA,
    });
  }

  /**
   * Reivindica o LEASE da geração do boleto. Só passa quem encontra:
   *  - a revistoria num estado que permite gerar;
   *  - o lease livre ou vencido;
   *  - o mesmo `boletoTentativas` que leu (ninguém tentou desde a leitura).
   *
   * Na mesma escrita a revistoria passa a `PENDENTE_RETRY` com a próxima
   * tentativa no vencimento do lease: se o processo morrer no meio, a
   * varredura de retry retoma sozinha, em vez de a revistoria ficar parada
   * em `NAO_GERADO`.
   *
   * @returns `true` se ESTE chamador é o dono do lease.
   */
  async reivindicarLease(params: {
    reinspectionId: number;
    dono: string;
    agora: Date;
    leaseMs: number;
    tentativasLidas: number;
    estadosPermitidos: ReinspectionBoletoStatus[];
    inicioDaJanela: Date;
  }): Promise<boolean> {
    const leaseAte = new Date(params.agora.getTime() + params.leaseMs);
    const { count } = await this.prisma.reinspection.updateMany({
      where: {
        id: params.reinspectionId,
        boletoTentativas: params.tentativasLidas,
        boletoStatus: { in: params.estadosPermitidos },
        OR: [
          { boletoLeaseAte: null },
          { boletoLeaseAte: { lt: params.agora } },
        ],
      },
      data: {
        boletoLeaseAte: leaseAte,
        boletoLeaseDono: params.dono,
        boletoStatus: ReinspectionBoletoStatus.PENDENTE_RETRY,
        boletoTentativas: params.tentativasLidas + 1,
        boletoUltimaTentativaEm: params.agora,
        boletoProximaTentativaEm: leaseAte,
        boletoRetryInicioEm: params.inicioDaJanela,
      },
    });
    return count === 1;
  }

  /**
   * Boleto gerado (ou adotado): grava `GERADO` e solta o lease.
   *
   * O boleto já existe no SGA, então o estado precisa refleti-lo mesmo que o
   * lease tenha vencido no caminho: sem o lease, grava ainda assim, desde que
   * ninguém tenha marcado `GERADO` antes (e sem tocar o lease de outro dono).
   *
   * @returns `'COM_LEASE'`, `'SEM_LEASE'` (gravou depois de perder o lease)
   * ou `'JA_GERADO'` (outra tentativa concluiu antes; nada foi gravado).
   */
  async concluirGerado(params: {
    reinspectionId: number;
    dono: string;
    agora: Date;
    tentativa: number;
    nossoNumero: string | null;
    origem: 'CRIADO_APP' | 'ADOTADO_SGA';
  }): Promise<'COM_LEASE' | 'SEM_LEASE' | 'JA_GERADO'> {
    const data = {
      boletoStatus: ReinspectionBoletoStatus.GERADO,
      boletoTentativas: params.tentativa,
      boletoUltimaTentativaEm: params.agora,
      boletoProximaTentativaEm: null,
      boletoRetryInicioEm: null,
      boletoUltimoErro: null,
      boletoNossoNumero: params.nossoNumero,
      boletoOrigem: params.origem,
    };

    const comLease = await this.prisma.reinspection.updateMany({
      where: { id: params.reinspectionId, boletoLeaseDono: params.dono },
      data: { ...data, boletoLeaseAte: null, boletoLeaseDono: null },
    });
    if (comLease.count === 1) return 'COM_LEASE';

    const semLease = await this.prisma.reinspection.updateMany({
      where: {
        id: params.reinspectionId,
        boletoStatus: { not: ReinspectionBoletoStatus.GERADO },
      },
      data,
    });
    return semLease.count === 1 ? 'SEM_LEASE' : 'JA_GERADO';
  }

  /**
   * Instabilidade: fica em `PENDENTE_RETRY` com a próxima tentativa agendada
   * e solta o lease. Só o dono do lease grava.
   */
  async agendarNovaTentativa(params: {
    reinspectionId: number;
    dono: string;
    agora: Date;
    tentativa: number;
    proximaTentativaEm: Date;
    inicioDaJanela: Date;
    erro: string;
    /** Boleto já cadastrado no SGA cuja gravação local falhou. */
    nossoNumeroCadastrado?: string | null;
  }): Promise<boolean> {
    const { count } = await this.prisma.reinspection.updateMany({
      where: {
        id: params.reinspectionId,
        boletoLeaseDono: params.dono,
        boletoStatus: { not: ReinspectionBoletoStatus.GERADO },
      },
      data: {
        boletoStatus: ReinspectionBoletoStatus.PENDENTE_RETRY,
        boletoTentativas: params.tentativa,
        boletoUltimaTentativaEm: params.agora,
        boletoProximaTentativaEm: params.proximaTentativaEm,
        boletoUltimoErro: params.erro,
        boletoRetryInicioEm: params.inicioDaJanela,
        boletoLeaseAte: null,
        boletoLeaseDono: null,
        ...this.boletoCadastrado(params.nossoNumeroCadastrado),
      },
    });
    return count === 1;
  }

  /** Erro definitivo (ou janela esgotada): `FALHA` e lease solto. */
  async registrarFalha(params: {
    reinspectionId: number;
    dono: string;
    agora: Date;
    tentativa: number;
    erro: string;
    nossoNumeroCadastrado?: string | null;
  }): Promise<boolean> {
    const { count } = await this.prisma.reinspection.updateMany({
      where: {
        id: params.reinspectionId,
        boletoLeaseDono: params.dono,
        boletoStatus: { not: ReinspectionBoletoStatus.GERADO },
      },
      data: {
        boletoStatus: ReinspectionBoletoStatus.FALHA,
        boletoTentativas: params.tentativa,
        boletoUltimaTentativaEm: params.agora,
        boletoProximaTentativaEm: null,
        boletoRetryInicioEm: null,
        boletoUltimoErro: params.erro,
        boletoLeaseAte: null,
        boletoLeaseDono: null,
        ...this.boletoCadastrado(params.nossoNumeroCadastrado),
      },
    });
    return count === 1;
  }

  /**
   * Revistorias em `PENDENTE_RETRY` com a tentativa vencida e o lease livre:
   * o que a varredura de retry precisa processar agora. Usa o índice
   * `(boletoStatus, boletoProximaTentativaEm)`.
   */
  async listarRetriesVencidos(agora: Date, limite: number): Promise<number[]> {
    const linhas = await this.prisma.reinspection.findMany({
      where: {
        boletoStatus: ReinspectionBoletoStatus.PENDENTE_RETRY,
        AND: [
          {
            OR: [
              { boletoProximaTentativaEm: null },
              { boletoProximaTentativaEm: { lte: agora } },
            ],
          },
          { OR: [{ boletoLeaseAte: null }, { boletoLeaseAte: { lt: agora } }] },
        ],
      },
      orderBy: [{ boletoProximaTentativaEm: 'asc' }, { id: 'asc' }],
      take: limite,
      select: { id: true },
    });
    return linhas.map((linha) => linha.id);
  }

  /** Revistorias aguardando retry ou com falha definitiva (visão do painel). */
  async listarPendentes() {
    const itens = await this.prisma.reinspection.findMany({
      where: {
        boletoStatus: {
          in: [
            ReinspectionBoletoStatus.PENDENTE_RETRY,
            ReinspectionBoletoStatus.FALHA,
          ],
        },
      },
      orderBy: { boletoUltimaTentativaEm: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        vehicleType: true,
        status: true,
        boletoStatus: true,
        boletoTentativas: true,
        boletoUltimaTentativaEm: true,
        boletoProximaTentativaEm: true,
        boletoUltimoErro: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: { select: { chassi: true, plate: true } },
      },
    });
    return itens.map(({ userVehicle, ...r }) => ({
      ...r,
      chassi: userVehicle.chassi,
      plate: userVehicle.plate,
    }));
  }

  private boletoCadastrado(nossoNumero: string | null | undefined) {
    return nossoNumero
      ? { boletoNossoNumero: nossoNumero, boletoOrigem: 'CRIADO_APP' }
      : {};
  }
}
