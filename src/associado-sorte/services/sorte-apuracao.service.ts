import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SorteMecanica,
  SorteRodadaEstado,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro409 } from 'src/associado-sorte/helpers/sorte-erros';
import { sortearGanhadores } from 'src/associado-sorte/helpers/sorte.helpers';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAleatorioService } from 'src/associado-sorte/services/sorte-aleatorio.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';

const DIA_MS = 24 * 60 * 60 * 1000;

/** Resumo gravado em `SorteRodada.resumoApuracao` para auditoria. */
export interface ResumoApuracao {
  apuradaEm: string;
  origem: 'JOB' | 'MANUAL';
  totalInscritos: number;
  totalBilhetes: number;
  /** Inscritos que concorreram (fora carência e cadastro inativo). */
  elegiveis: number;
  bilhetesElegiveis: number;
  puladosPorCarencia: number;
  puladosPorInatividade: number;
  unidades: number;
  estoqueNaApuracao: number;
  /** `true` quando o estoque era menor que as unidades da rodada. */
  limitadoPeloEstoque: boolean;
  ganhadores: number;
}

export interface ApuracaoResultado {
  rodadaId: number;
  /** `true` quando a rodada já estava apurada (nada mudou agora). */
  jaApurada: boolean;
  resumo: ResumoApuracao | null;
  ganhadorIds: number[];
}

/** Apuração do sorteio (seção 4.3 e 5.2): idempotente e auditável. */
@Injectable()
export class SorteApuracaoService {
  private readonly logger = new Logger(SorteApuracaoService.name);

  constructor(
    private readonly uow: SorteUnidadeTrabalho,
    private readonly config: SorteConfigService,
    private readonly ganhadores: SorteGanhadoresService,
    private readonly aleatorio: SorteAleatorioService,
    private readonly notificacoes: SorteNotificacoesService,
  ) {}

  /**
   * Trava a rodada, confere o estado e só então apura. Rodar duas vezes não
   * gera ganhadores em dobro: a segunda execução encontra a rodada
   * `ENCERRADA` e devolve `jaApurada: true`.
   *
   * Sorteia `quantidade` ganhadores distintos com chance proporcional aos
   * bilhetes. Quem está em carência ou com cadastro inativo é pulado. Com
   * estoque menor que as unidades, premia só até onde o estoque alcança.
   */
  async apurar(
    rodadaId: number,
    origem: 'JOB' | 'MANUAL' = 'JOB',
  ): Promise<ApuracaoResultado> {
    const resultado = await this.uow.executar(
      async (tx): Promise<ApuracaoResultado> => {
        const agora = new Date();
        const rodada = await tx.travarRodada(rodadaId);
        if (!rodada) throw new NotFoundException('Rodada não encontrada');
        if (rodada.mecanica !== SorteMecanica.SORTEIO) {
          throw new BadRequestException('Só rodadas de sorteio são apuradas');
        }
        if (
          rodada.estado !== SorteRodadaEstado.PUBLICADA &&
          rodada.estado !== SorteRodadaEstado.APURANDO
        ) {
          if (rodada.estado === SorteRodadaEstado.ENCERRADA) {
            return { rodadaId, jaApurada: true, resumo: null, ganhadorIds: [] };
          }
          throw erro409(
            'RODADA_NAO_PUBLICADA',
            'Só rodadas publicadas podem ser apuradas',
          );
        }
        if (agora.getTime() < rodada.encerramento.getTime()) {
          throw erro409(
            'RODADA_NAO_ENCERRADA',
            'O sorteio ainda está aberto. Para antecipar, edite o encerramento.',
          );
        }

        const premio = await tx.travarPremio(rodada.premioId);
        const estoque = Math.max(0, premio?.estoque ?? 0);
        const participacoes = await tx.listarParticipacoes(rodadaId);

        // Carência é configuração da base de cada inscrito.
        const emCarencia = new Set<number>();
        const porBase = new Map<string, number[]>();
        for (const p of participacoes) {
          porBase.set(p.baseOrigin, [
            ...(porBase.get(p.baseOrigin) ?? []),
            p.userId,
          ]);
        }
        for (const [baseOrigin, userIds] of porBase) {
          const { carenciaDias } = await this.config.obter(baseOrigin);
          if (carenciaDias <= 0) continue;
          const desde = new Date(agora.getTime() - carenciaDias * DIA_MS);
          for (const id of await tx.usuariosEmCarencia(userIds, desde)) {
            emCarencia.add(id);
          }
        }

        const inativos = participacoes.filter((p) => !p.user.isActive);
        const elegiveis = participacoes.filter(
          (p) => p.user.isActive && !emCarencia.has(p.userId),
        );

        const limite = Math.min(rodada.quantidade, estoque);
        const sorteados = premio
          ? sortearGanhadores(
              elegiveis.map((p) => ({
                userId: p.userId,
                bilhetes: p.bilhetes,
              })),
              limite,
              this.aleatorio.inteiro,
            )
          : [];

        const ganhadorIds: number[] = [];
        for (const userId of sorteados) {
          const participacao = elegiveis.find((p) => p.userId === userId)!;
          const ganhador = await this.ganhadores.registrar(tx, {
            rodada,
            premio: premio!,
            userId,
            baseOrigin: participacao.baseOrigin,
            creditosGastos: participacao.creditosGastos,
          });
          ganhadorIds.push(ganhador.id);
        }

        const somar = (lista: { bilhetes: number }[]) =>
          lista.reduce((soma, p) => soma + p.bilhetes, 0);
        const resumo: ResumoApuracao = {
          apuradaEm: agora.toISOString(),
          origem,
          totalInscritos: participacoes.length,
          totalBilhetes: somar(participacoes),
          elegiveis: elegiveis.length,
          bilhetesElegiveis: somar(elegiveis),
          puladosPorCarencia: participacoes.filter((p) =>
            emCarencia.has(p.userId),
          ).length,
          puladosPorInatividade: inativos.length,
          unidades: rodada.quantidade,
          estoqueNaApuracao: estoque,
          limitadoPeloEstoque: estoque < rodada.quantidade,
          ganhadores: ganhadorIds.length,
        };

        await tx.atualizarRodada(rodadaId, {
          estado: SorteRodadaEstado.ENCERRADA,
          quantidadeRestante: rodada.quantidade - ganhadorIds.length,
          apuradaEm: agora,
          resumoApuracao: resumo as unknown as Prisma.InputJsonValue,
        });
        return { rodadaId, jaApurada: false, resumo, ganhadorIds };
      },
      { longa: true },
    );

    if (!resultado.jaApurada && resultado.resumo) {
      const r = resultado.resumo;
      this.logger.log(
        `Sorteio #${rodadaId} apurado (${origem}): ${r.totalInscritos} inscrito(s), ${r.totalBilhetes} bilhete(s), ${r.ganhadores} ganhador(es)${r.limitadoPeloEstoque ? ' — limitado pelo estoque' : ''}`,
      );
    }
    if (resultado.ganhadorIds.length > 0) {
      // Depois do commit; vários ganhadores vão pela fila de notificações.
      this.notificacoes
        .avisarGanhadores(resultado.ganhadorIds)
        .catch((erro: Error) =>
          this.logger.error(`Falha ao avisar ganhadores: ${erro.message}`),
        );
    }
    return resultado;
  }
}
