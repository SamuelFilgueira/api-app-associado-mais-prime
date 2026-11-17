import { Injectable } from '@nestjs/common';
import { SorteRaspada } from '@prisma/client';
import { diaParaDate } from 'src/associado-sorte/helpers/sorte-data.helper';
import { PrismaService } from 'src/database/prisma.service';

/** Candidato ao push "Sua raspadinha está liberada". */
export interface CandidatoLembrete {
  userId: number;
  expoPushToken: string;
  raspadasHoje: number;
  ultimaRaspadaHojeEm: Date | null;
  lembreteRaspadaEm: Date | null;
}

/** Raspadas (histórico) e o lembrete programático, fora de transação. */
@Injectable()
export class SorteRaspadasRepository {
  constructor(private readonly prisma: PrismaService) {}

  async estadoDoDia(
    userId: number,
    dia: string,
  ): Promise<{ total: number; ultimaEm: Date | null }> {
    const r = await this.prisma.sorteRaspada.aggregate({
      where: { userId, dia: diaParaDate(dia) },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return { total: r._count._all, ultimaEm: r._max.createdAt ?? null };
  }

  async listarDoAssociado(params: {
    userId: number;
    skip: number;
    take: number;
  }): Promise<{ data: SorteRaspada[]; total: number }> {
    const where = { userId: params.userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteRaspada.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteRaspada.count({ where }),
    ]);
    return { data, total };
  }

  contarDoDia(baseOrigin: string, dia: string): Promise<number> {
    return this.prisma.sorteRaspada.count({
      where: { baseOrigin, dia: diaParaDate(dia) },
    });
  }

  contarVouchersDoDia(baseOrigin: string, dia: string): Promise<number> {
    return this.prisma.sorteRaspada.count({
      where: { baseOrigin, dia: diaParaDate(dia), resultado: 'GANHOU' },
    });
  }

  /**
   * Inscritos (com token de push e cadastro ativo) que têm raspada liberada
   * agora e ainda não foram avisados dessa liberação. O filtro é feito no
   * banco para o lote não ficar preso em quem não precisa de aviso.
   * Liberação = 00:00 do dia (sem raspada hoje) ou última raspada + intervalo.
   */
  async listarCandidatosLembrete(params: {
    baseOrigin: string;
    dia: string;
    inicioDoDia: Date;
    agora: Date;
    raspadasPorDia: number;
    intervaloMinimoMinutos: number;
    lote: number;
  }): Promise<CandidatoLembrete[]> {
    const dia = diaParaDate(params.dia);
    const linhas = await this.prisma.$queryRaw<
      {
        userId: number;
        expoPushToken: string;
        raspadasHoje: bigint | number;
        ultimaRaspadaHojeEm: Date | null;
        lembreteRaspadaEm: Date | null;
      }[]
    >`
      SELECT x.userId, x.expoPushToken, x.raspadasHoje, x.ultimaRaspadaHojeEm,
             x.lembreteRaspadaEm
      FROM (
        SELECT i.userId, u.expoPushToken, c.lembreteRaspadaEm,
               COUNT(r.id) AS raspadasHoje,
               MAX(r.createdAt) AS ultimaRaspadaHojeEm
        FROM SorteInscricao i
        JOIN \`user\` u ON u.id = i.userId
        LEFT JOIN SorteCarteira c ON c.userId = i.userId
        LEFT JOIN SorteRaspada r ON r.userId = i.userId AND r.dia = ${dia}
        WHERE i.baseOrigin = ${params.baseOrigin}
          AND i.inscrito = 1
          AND u.isActive = 1
          AND u.expoPushToken IS NOT NULL
          AND u.expoPushToken <> ''
        GROUP BY i.userId, u.expoPushToken, c.lembreteRaspadaEm
      ) x
      WHERE x.raspadasHoje < ${params.raspadasPorDia}
        AND (CASE WHEN x.raspadasHoje = 0 THEN ${params.inicioDoDia}
             ELSE DATE_ADD(x.ultimaRaspadaHojeEm, INTERVAL ${params.intervaloMinimoMinutos} MINUTE)
             END) <= ${params.agora}
        AND (x.lembreteRaspadaEm IS NULL OR x.lembreteRaspadaEm <
             (CASE WHEN x.raspadasHoje = 0 THEN ${params.inicioDoDia}
              ELSE DATE_ADD(x.ultimaRaspadaHojeEm, INTERVAL ${params.intervaloMinimoMinutos} MINUTE)
              END))
      ORDER BY x.userId
      LIMIT ${params.lote}`;
    return linhas.map((l) => ({
      userId: Number(l.userId),
      expoPushToken: l.expoPushToken,
      raspadasHoje: Number(l.raspadasHoje),
      ultimaRaspadaHojeEm: l.ultimaRaspadaHojeEm
        ? new Date(l.ultimaRaspadaHojeEm)
        : null,
      lembreteRaspadaEm: l.lembreteRaspadaEm
        ? new Date(l.lembreteRaspadaEm)
        : null,
    }));
  }

  /**
   * Reivindica o aviso de uma liberação: só grava (e devolve `true`) se essa
   * liberação ainda não foi avisada. Nunca dois pushes para a mesma.
   */
  async reivindicarLembrete(
    userId: number,
    baseOrigin: string,
    liberacao: Date,
  ): Promise<boolean> {
    await this.prisma.sorteCarteira.createMany({
      data: [{ userId, baseOrigin }],
      skipDuplicates: true,
    });
    const r = await this.prisma.sorteCarteira.updateMany({
      where: {
        userId,
        OR: [
          { lembreteRaspadaEm: null },
          { lembreteRaspadaEm: { lt: liberacao } },
        ],
      },
      data: { lembreteRaspadaEm: liberacao },
    });
    return r.count > 0;
  }
}
