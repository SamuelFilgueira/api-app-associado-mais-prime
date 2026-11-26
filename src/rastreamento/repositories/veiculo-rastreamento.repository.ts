import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import {
  EstadoDoVeiculo,
  EstadoGravadoNoVeiculo,
  valorAgregadoDoUsuario,
} from 'src/rastreamento/domain/estado-veiculo';
import { MemoriaDeProvedor } from 'src/rastreamento/domain/sondagem';

/** Vínculo local (`UserVehicle`) de um chassi, com o estado dele e o do dono. */
export interface VinculoDoVeiculo {
  id: number;
  userId: number;
  veiculo: EstadoGravadoNoVeiculo;
  usuario: EstadoDoVeiculo;
}

export interface RegistroDeComando {
  /** Associado que pediu; `null` quando o token é do painel. */
  userId: number | null;
  /** Usuário do painel que pediu, quando não foi um associado. */
  adminPanelUserId?: number | null;
  userVehicleId: number | null;
  chassi: string;
  baseOrigin: string | null;
  comando: 'ANCORA' | 'IGNICAO';
  valor: boolean;
  resultado: 'OK' | 'FALHA';
  erro?: string | null;
}

const SELECAO_DO_VINCULO = {
  id: true,
  userId: true,
  ancoraAtiva: true,
  notificacaoIgnicao: true,
  user: { select: { ancoraAtiva: true, notificacaoIgnicao: true } },
} as const;

type LinhaDoVinculo = {
  id: number;
  userId: number;
  ancoraAtiva: boolean | null;
  notificacaoIgnicao: boolean | null;
  user: { ancoraAtiva: boolean; notificacaoIgnicao: boolean };
};

function paraVinculo(linha: LinhaDoVinculo | null): VinculoDoVeiculo | null {
  if (!linha) return null;
  return {
    id: linha.id,
    userId: linha.userId,
    veiculo: {
      ancoraAtiva: linha.ancoraAtiva,
      notificacaoIgnicao: linha.notificacaoIgnicao,
    },
    usuario: {
      ancoraAtiva: linha.user.ancoraAtiva,
      notificacaoIgnicao: linha.user.notificacaoIgnicao,
    },
  };
}

/**
 * Tudo o que o rastreamento lê e grava em `UserVehicle` (e na auditoria de
 * comandos). Nenhuma consulta daqui amarra o chassi ao usuário logado para
 * RECUSAR: o vínculo do próprio usuário só tem preferência quando existe.
 *
 * Consulta sem chassi devolve "não encontrado" — o Prisma ignora filtro
 * `undefined`, e a busca cairia num veículo qualquer.
 */
@Injectable()
export class VeiculoRastreamentoRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** O veículo está com o rastreamento cortado pelo painel? */
  async rastreamentoCortado(chassi: string): Promise<boolean> {
    if (!chassi) return false;
    const veiculo = await this.prisma.userVehicle.findFirst({
      where: { chassi },
      select: { cortarRastreamento: true },
    });
    return veiculo?.cortarRastreamento === true;
  }

  /** Base do dono do veículo (fluxo sem requisição do app). */
  async baseDoDono(chassi: string): Promise<string | null> {
    if (!chassi) return null;
    const veiculo = await this.prisma.userVehicle.findFirst({
      where: { chassi },
      select: { user: { select: { baseOrigin: true } } },
    });
    return veiculo?.user?.baseOrigin ?? null;
  }

  // ------------------------------------------------------------------
  // Provedor de rastreamento do veículo
  // ------------------------------------------------------------------

  /** `null` quando o chassi não tem vínculo local. */
  async memoriaDeProvedor(chassi: string): Promise<MemoriaDeProvedor | null> {
    if (!chassi) return null;
    const veiculo = await this.prisma.userVehicle.findFirst({
      where: { chassi },
      select: {
        provedorRastreamento: true,
        provedorFalhas: true,
        provedorVerificadoEm: true,
      },
    });
    if (!veiculo) return null;
    return {
      provedor: veiculo.provedorRastreamento,
      falhas: veiculo.provedorFalhas,
      verificadoEm: veiculo.provedorVerificadoEm?.getTime() ?? null,
    };
  }

  /**
   * Grava o provedor que venceu uma rodada completa e zera as falhas.
   * Devolve quantos vínculos foram atualizados (0 = chassi sem vínculo).
   */
  async gravarProvedor(
    chassi: string,
    provedor: string,
    verificadoEm: Date,
  ): Promise<number> {
    if (!chassi) return 0;
    const { count } = await this.prisma.userVehicle.updateMany({
      where: { chassi },
      data: {
        provedorRastreamento: provedor,
        provedorVerificadoEm: verificadoEm,
        provedorFalhas: 0,
      },
    });
    return count;
  }

  /** Mais uma falha seguida do provedor gravado (só se ele ainda for o gravado). */
  async registrarFalhaDoProvedor(
    chassi: string,
    provedor: string,
  ): Promise<number> {
    if (!chassi) return 0;
    const { count } = await this.prisma.userVehicle.updateMany({
      where: { chassi, provedorRastreamento: provedor },
      data: { provedorFalhas: { increment: 1 } },
    });
    return count;
  }

  /** O provedor gravado voltou a responder. */
  async zerarFalhasDoProvedor(
    chassi: string,
    provedor: string,
  ): Promise<number> {
    if (!chassi) return 0;
    const { count } = await this.prisma.userVehicle.updateMany({
      where: {
        chassi,
        provedorRastreamento: provedor,
        provedorFalhas: { gt: 0 },
      },
      data: { provedorFalhas: 0 },
    });
    return count;
  }

  // ------------------------------------------------------------------
  // Âncora e alerta de ignição
  // ------------------------------------------------------------------

  /**
   * Vínculo do chassi: o do próprio usuário, se existir; senão o primeiro
   * vínculo do chassi (comportamento de sempre). `somenteAtivos` reproduz o
   * filtro do status de ignição (veículo e dono ativos).
   */
  async vinculo(
    chassi: string,
    userId: number | null,
    opcoes: { somenteAtivos?: boolean } = {},
  ): Promise<VinculoDoVeiculo | null> {
    if (!chassi) return null;
    const filtro: Prisma.UserVehicleWhereInput = opcoes.somenteAtivos
      ? { chassi, isActive: true, user: { isActive: true } }
      : { chassi };

    if (userId !== null) {
      const proprio = await this.prisma.userVehicle.findFirst({
        where: { ...filtro, userId },
        select: SELECAO_DO_VINCULO,
      });
      if (proprio) return paraVinculo(proprio);
    }

    return paraVinculo(
      await this.prisma.userVehicle.findFirst({
        where: filtro,
        select: SELECAO_DO_VINCULO,
      }),
    );
  }

  /**
   * Algum vínculo ativo do chassi está com o alerta ligado? Lê o VEÍCULO; se
   * ele ainda está `null`, vale o valor do usuário.
   */
  async haAlertaLigado(chassi: string): Promise<boolean> {
    if (!chassi) return false;
    const vinculos = await this.prisma.userVehicle.findMany({
      where: { chassi, isActive: true, user: { isActive: true } },
      select: {
        notificacaoIgnicao: true,
        user: { select: { notificacaoIgnicao: true } },
      },
    });
    return vinculos.some(
      (v) => (v.notificacaoIgnicao ?? v.user.notificacaoIgnicao) === true,
    );
  }

  /**
   * Grava no veículo o estado que acabou de ser enviado ao rastreador e
   * registra o comando, na mesma transação.
   *
   * Passos, com a linha do dono travada (`FOR UPDATE`) para que dois comandos
   * em veículos diferentes do mesmo usuário não se atropelem:
   *  1. os OUTROS veículos do dono que ainda estão `null` recebem o valor
   *     antigo do usuário — é o que eles já valiam; sem isso, mudar o valor
   *     do usuário mudaria o estado deles;
   *  2. o veículo comandado recebe o estado novo;
   *  3. o usuário (coluna antiga) recebe o agregado dos veículos ativos.
   *
   * Devolve `false` se o vínculo sumiu no meio do caminho.
   */
  async gravarEstado(
    vinculo: Pick<VinculoDoVeiculo, 'id' | 'userId'>,
    estado: EstadoDoVeiculo,
    comando: RegistroDeComando,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`user\` WHERE id = ${vinculo.userId} FOR UPDATE`;

      const dono = await tx.user.findUnique({
        where: { id: vinculo.userId },
        select: { ancoraAtiva: true, notificacaoIgnicao: true },
      });

      if (dono) {
        await tx.userVehicle.updateMany({
          where: {
            userId: vinculo.userId,
            id: { not: vinculo.id },
            ancoraAtiva: null,
          },
          data: { ancoraAtiva: dono.ancoraAtiva },
        });
        await tx.userVehicle.updateMany({
          where: {
            userId: vinculo.userId,
            id: { not: vinculo.id },
            notificacaoIgnicao: null,
          },
          data: { notificacaoIgnicao: dono.notificacaoIgnicao },
        });
      }

      const { count } = await tx.userVehicle.updateMany({
        where: { id: vinculo.id, userId: vinculo.userId },
        data: {
          ancoraAtiva: estado.ancoraAtiva,
          notificacaoIgnicao: estado.notificacaoIgnicao,
        },
      });

      if (count === 1 && dono) {
        const veiculos = await tx.userVehicle.findMany({
          where: {
            userId: vinculo.userId,
            OR: [{ isActive: true }, { id: vinculo.id }],
          },
          select: { ancoraAtiva: true, notificacaoIgnicao: true },
        });
        await tx.user.updateMany({
          where: { id: vinculo.userId },
          data: {
            ancoraAtiva: valorAgregadoDoUsuario(
              veiculos.map((v) => v.ancoraAtiva ?? dono.ancoraAtiva),
            ),
            notificacaoIgnicao: valorAgregadoDoUsuario(
              veiculos.map(
                (v) => v.notificacaoIgnicao ?? dono.notificacaoIgnicao,
              ),
            ),
          },
        });
      }

      await tx.veiculoComandoLog.create({ data: paraLinhaDoLog(comando) });
      return count === 1;
    });
  }

  /** Linha de auditoria do comando (quando não há estado a gravar). */
  async registrarComando(comando: RegistroDeComando): Promise<void> {
    await this.prisma.veiculoComandoLog.create({
      data: paraLinhaDoLog(comando),
    });
  }
}

function paraLinhaDoLog(
  comando: RegistroDeComando,
): Prisma.VeiculoComandoLogCreateInput {
  return {
    userId: comando.userId,
    adminPanelUserId: comando.adminPanelUserId ?? null,
    userVehicleId: comando.userVehicleId,
    chassi: comando.chassi.slice(0, 100),
    baseOrigin: comando.baseOrigin,
    comando: comando.comando,
    valor: comando.valor,
    resultado: comando.resultado,
    erro: comando.erro ? comando.erro.slice(0, 255) : null,
  };
}
