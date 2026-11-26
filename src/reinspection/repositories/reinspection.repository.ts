import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ReinspectionStatus,
  ReinspectionVehicleType,
} from '@prisma/client';
import { comRetryEmConflito } from 'src/database/conflito-escrita.util';
import { PrismaService } from 'src/database/prisma.service';
import {
  erroDeTransicaoInvalida,
  exigirArestasNaTabela,
} from 'src/reinspection/domain/revistoria-transicoes';

/**
 * Limites da transação que trava a revistoria. O painel aprova todas as
 * fotos em paralelo e elas passam uma a uma pela trava: o prazo cobre a fila
 * inteira (o padrão do Prisma, 5 s, é curto para uma revistoria com muitas
 * fotos num banco ocupado).
 */
const TRANSACAO_TRAVADA = { maxWait: 5_000, timeout: 15_000 };

/** Cliente do Prisma: o serviço ou a transação em curso. */
export type ClienteRevistoria = Prisma.TransactionClient;

/**
 * Campos da revistoria nas listagens e no detalhe do painel. Era repetido em
 * `listAll`, `listRecent` e `searchByChassiOrPlate`.
 */
export const REVISTORIA_RESUMO_SELECT = {
  id: true,
  userVehicleId: true,
  vehicleType: true,
  status: true,
  hinovaEnvioStatus: true,
  hinovaUltimoEnvioEm: true,
  boletoStatus: true,
  boletoTentativas: true,
  boletoUltimaTentativaEm: true,
  boletoProximaTentativaEm: true,
  boletoUltimoErro: true,
  boletoNossoNumero: true,
  boletoOrigem: true,
  createdAt: true,
  updatedAt: true,
  userVehicle: { select: { chassi: true, plate: true } },
  _count: { select: { photos: true } },
} satisfies Prisma.ReinspectionSelect;

const REVISTORIA_DETALHE_SELECT = {
  ...REVISTORIA_RESUMO_SELECT,
  codigoVeiculo: true,
  _count: { select: { photos: true, hinovaEnvios: true } },
} satisfies Prisma.ReinspectionSelect;

/** Estado atual da revistoria (o que se relê depois de uma transição). */
const ESTADO_SELECT = {
  id: true,
  userVehicleId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  boletoStatus: true,
  boletoTentativas: true,
  boletoProximaTentativaEm: true,
  boletoUltimoErro: true,
  boletoNossoNumero: true,
} satisfies Prisma.ReinspectionSelect;

export type EstadoDaRevistoria = Prisma.ReinspectionGetPayload<{
  select: typeof ESTADO_SELECT;
}>;

export interface ResultadoDaTransicao {
  /** `true` só para quem efetivamente mudou o status. */
  ganhou: boolean;
  status: ReinspectionStatus;
}

export interface OpcoesDaTransicao {
  /**
   * A revistoria já estar no destino é repetição legítima (a rota respondia
   * 200): devolve `ganhou = false` em vez de lançar 409.
   */
  repeticaoIdempotente?: boolean;
  cliente?: ClienteRevistoria;
}

@Injectable()
export class ReinspectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Leituras ──────────────────────────────────────────────────────────────

  veiculo(userVehicleId: number) {
    return this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { id: true, userId: true, chassi: true, plate: true },
    });
  }

  /** Última revistoria do veículo: as rotas por `userVehicleId` agem nela. */
  ultimaDoVeiculo(userVehicleId: number) {
    return this.prisma.reinspection.findFirst({
      where: { userVehicleId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        vehicleType: true,
        codigoVeiculo: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { photos: true } },
      },
    });
  }

  estado(
    id: number,
    cliente: ClienteRevistoria = this.prisma,
  ): Promise<EstadoDaRevistoria | null> {
    return cliente.reinspection.findUnique({
      where: { id },
      select: ESTADO_SELECT,
    });
  }

  async estadoOuFalha(
    id: number,
    cliente?: ClienteRevistoria,
  ): Promise<EstadoDaRevistoria> {
    const estado = await this.estado(id, cliente);
    if (!estado) throw new NotFoundException('Revistoria não encontrada');
    return estado;
  }

  /** Revistoria com o veículo e o dono dele (checagem de posse). */
  comDono(id: number) {
    return this.prisma.reinspection.findUnique({
      where: { id },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        userVehicle: { select: { userId: true, chassi: true, plate: true } },
      },
    });
  }

  /** Revistoria com o dono do veículo e as fotos (submissão do app). */
  comDonoEFotos(id: number) {
    return this.prisma.reinspection.findUnique({
      where: { id },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        photos: { orderBy: { id: 'asc' }, select: { url: true } },
        userVehicle: { select: { userId: true, chassi: true, plate: true } },
      },
    });
  }

  listar(limite?: number) {
    return this.prisma.reinspection.findMany({
      ...(limite != null ? { take: limite } : {}),
      orderBy: { createdAt: 'desc' },
      select: REVISTORIA_RESUMO_SELECT,
    });
  }

  buscarPorVeiculo(termos: { chassi?: string; plate?: string }) {
    const filtros: Prisma.ReinspectionWhereInput[] = [];
    if (termos.chassi) {
      filtros.push({ userVehicle: { chassi: { contains: termos.chassi } } });
    }
    if (termos.plate) {
      filtros.push({ userVehicle: { plate: { contains: termos.plate } } });
    }
    return this.prisma.reinspection.findMany({
      where: { OR: filtros },
      orderBy: { createdAt: 'desc' },
      select: REVISTORIA_RESUMO_SELECT,
    });
  }

  detalhe(id: number) {
    return this.prisma.reinspection.findUnique({
      where: { id },
      select: REVISTORIA_DETALHE_SELECT,
    });
  }

  async totais() {
    const contar = (status: ReinspectionStatus) =>
      this.prisma.reinspection.count({ where: { status } });
    const [aprovadas, emAnalise, reprovadas, totalRevistorias] =
      await this.prisma.$transaction([
        contar(ReinspectionStatus.APROVADA),
        contar(ReinspectionStatus.EM_ANALISE),
        contar(ReinspectionStatus.REPROVADA),
        this.prisma.reinspection.count(),
      ]);
    return { aprovadas, emAnalise, reprovadas, totalRevistorias };
  }

  // ── Escritas ──────────────────────────────────────────────────────────────

  criar(dados: {
    userVehicleId: number;
    vehicleType: ReinspectionVehicleType;
    codigoVeiculo: number | null;
  }) {
    return this.prisma.reinspection.create({
      data: dados,
      select: { id: true, status: true, createdAt: true },
    });
  }

  /**
   * ÚNICO ponto que grava `Reinspection.status`.
   *
   * `UPDATE ... WHERE id = ? AND status IN (de)`: de duas chamadas
   * simultâneas, só uma afeta a linha. Quem não afeta relê o estado:
   *  - já está no destino e a operação aceita repetição → `ganhou = false`
   *    (o chamador devolve o estado atual e NÃO repete efeito colateral);
   *  - qualquer outro caso → 409 `REVISTORIA_TRANSICAO_INVALIDA`.
   */
  async transicionar(
    id: number,
    de: readonly ReinspectionStatus[],
    para: ReinspectionStatus,
    opcoes: OpcoesDaTransicao = {},
  ): Promise<ResultadoDaTransicao> {
    exigirArestasNaTabela(de, para);
    const cliente = opcoes.cliente ?? this.prisma;

    const { count } = await cliente.reinspection.updateMany({
      where: { id, status: { in: [...de] } },
      data: { status: para },
    });
    if (count > 0) return { ganhou: true, status: para };

    const atual = await cliente.reinspection.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!atual) throw new NotFoundException('Revistoria não encontrada');
    if (atual.status === para && opcoes.repeticaoIdempotente) {
      return { ganhou: false, status: atual.status };
    }
    throw erroDeTransicaoInvalida(atual.status, para);
  }

  /**
   * Executa `fn` com a linha da revistoria travada (`SELECT ... FOR UPDATE`).
   *
   * Avaliar foto lê as outras fotos e depois grava o status da revistoria;
   * sem a trava, uma aprovação e uma reprovação simultâneas decidiam com o
   * mesmo retrato e a última a gravar vencia. READ COMMITTED para que as
   * leituras feitas depois de esperar a trava enxerguem o que o dono
   * anterior commitou.
   */
  comRevistoriaTravada<T>(
    id: number,
    fn: (tx: ClienteRevistoria) => Promise<T>,
  ): Promise<T> {
    return comRetryEmConflito(() =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM Reinspection WHERE id = ${id} FOR UPDATE`;
          return fn(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          ...TRANSACAO_TRAVADA,
        },
      ),
    );
  }
}
