import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseOrigin } from 'src/config/tenant.config';
import { CacheService } from 'src/infra/cache/cache.service';
import { escolherPosicao } from 'src/rastreamento/domain/posicao';
import {
  JanelasDeRevalidacao,
  planejarSondagem,
  precisaRevalidar,
} from 'src/rastreamento/domain/sondagem';
import {
  ConsultaDePosicao,
  PROVEDORES_DE_RASTREAMENTO,
  PosicaoDoProvedor,
  ProvedorDeRastreamento,
} from 'src/rastreamento/providers/rastreamento-provider.interface';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import { garantirRastreamentoLiberado } from 'src/rastreamento/services/rastreamento-liberado';
import { integracaoNaoConfigurada } from 'src/shared/erros/erros';
import { baseTag } from 'src/shared/log.util';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import { ehErroHttp } from 'src/integrations/core/erro-http';

/** Ajustes da consulta de posição (o app consulta a cada 5 s). */
export const CONFIG_DA_POSICAO = {
  /** Por quanto tempo a posição de um chassi é servida do cache. */
  cacheTtlSeg: 15,
  /** Prazo de cada provedor na sondagem em paralelo. */
  prazoDaSondagemMs: 4_000,
  /** Prazo do provedor já conhecido do veículo, chamado sozinho. */
  prazoDoConhecidoMs: 10_000,
  /** Falhas seguidas do provedor conhecido até voltar a sondar todos. */
  limiteDeFalhas: 3,
  janelas: {
    posicaoParadaMs: 15 * 60 * 1000,
    emMovimentoMs: 10 * 60 * 1000,
    paradoMs: 60 * 1000,
  } satisfies JanelasDeRevalidacao,
} as const;

export type RespostaDePosicao = Record<string, unknown> & { origem: string };

/** Posição de um provedor com data válida: entra na escolha. */
interface Candidato {
  origem: string;
  timestamp: number;
  posicao: PosicaoDoProvedor;
  provedor: ProvedorDeRastreamento;
}

type Desfecho =
  | { ok: true; candidato: Candidato }
  | { ok: false; motivo: string };

/**
 * Uma rodada de consulta aos provedores. Os provedores entram aos poucos
 * (`iniciar`) e cada um tem prazo: o que estoura fica fora da rodada, sem
 * derrubar a resposta. A chamada em si não é cancelada — termina em segundo
 * plano e deixa aquecidos o login e os caches do provedor.
 */
class Rodada {
  private readonly desfechos = new Map<string, Desfecho>();
  private readonly pendentes = new Map<string, Promise<void>>();

  constructor(
    private readonly consultar: (
      provedor: ProvedorDeRastreamento,
    ) => Promise<Desfecho>,
  ) {}

  iniciar(provedores: readonly ProvedorDeRastreamento[]): void {
    for (const provedor of provedores) {
      const andamento = this.consultar(provedor).then((desfecho) => {
        this.desfechos.set(provedor.nome, desfecho);
        this.pendentes.delete(provedor.nome);
      });
      this.pendentes.set(provedor.nome, andamento);
    }
  }

  /** Espera todos os iniciados terminarem ou o prazo passar. */
  async aguardar(prazoMs: number): Promise<void> {
    if (this.pendentes.size === 0) return;
    let temporizador: NodeJS.Timeout | undefined;
    const prazo = new Promise<void>((resolver) => {
      temporizador = setTimeout(resolver, prazoMs);
    });
    await Promise.race([Promise.all(this.pendentes.values()), prazo]);
    clearTimeout(temporizador);
  }

  /**
   * Nenhuma posição ainda e há provedor respondendo: espera a primeira que
   * chegar. Entre responder devagar e responder erro, responde.
   */
  async aguardarPrimeiraPosicao(): Promise<void> {
    while (this.candidatos().length === 0 && this.pendentes.size > 0) {
      await Promise.race(this.pendentes.values());
    }
  }

  desfecho(nome: string): Desfecho | undefined {
    return this.desfechos.get(nome);
  }

  candidatos(): Candidato[] {
    const validos: Candidato[] = [];
    for (const desfecho of this.desfechos.values()) {
      if (desfecho.ok) validos.push(desfecho.candidato);
    }
    return validos;
  }

  /** Provedores que não responderam dentro do prazo da rodada. */
  foraDoPrazo(): string[] {
    return [...this.pendentes.keys()];
  }
}

/**
 * Posição unificada de um veículo.
 *
 * - Cache curto por base e chassi, com uma única ida aos provedores para
 *   consultas simultâneas.
 * - O veículo lembra o provedor que respondeu: nas consultas seguintes só
 *   ele é chamado. Se ele falha, os demais respondem na mesma consulta; com
 *   falhas seguidas, ou passada a janela de conferência, todos são sondados
 *   de novo e o vencedor é regravado.
 * - Provedor sem credencial para a base fica fora, sem derrubar os demais.
 *
 * Não há checagem de posse: qualquer associado autenticado consulta qualquer
 * chassi. A única recusa é o corte do rastreamento feito pelo painel.
 */
@Injectable()
export class ConsultarPosicaoService {
  private readonly logger = new Logger(ConsultarPosicaoService.name);

  constructor(
    @Inject(PROVEDORES_DE_RASTREAMENTO)
    private readonly provedores: ProvedorDeRastreamento[],
    private readonly veiculos: VeiculoRastreamentoRepository,
    private readonly cache: CacheService,
  ) {}

  /**
   * `baseOrigin` ausente = fluxo sem requisição do app: vale a base do dono
   * do veículo (sem dono ou sem base válida, `BaseNaoResolvidaError`).
   */
  async executar(
    cnpj: string,
    chassi: string,
    baseOrigin?: BaseOrigin,
  ): Promise<RespostaDePosicao> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    const base = exigirBase(
      baseOrigin ?? (await this.veiculos.baseDoDono(chassi)),
      'rastreamento por chassi',
    );

    const { valor } = await this.cache.obter({
      base,
      chave: `pos:${String(chassi ?? '')
        .trim()
        .toUpperCase()}`,
      recurso: 'rastreamento_posicao',
      ttlSeg: CONFIG_DA_POSICAO.cacheTtlSeg,
      carregar: () => this.consultarProvedores({ base, chassi, cnpj }),
    });
    return valor;
  }

  private async consultarProvedores(
    consulta: ConsultaDePosicao,
  ): Promise<RespostaDePosicao> {
    const configurados = this.provedores.filter((p) =>
      p.estaConfigurado(consulta.base),
    );
    if (configurados.length === 0) {
      throw integracaoNaoConfigurada(
        'rastreamento',
        consulta.base,
        'nenhum provedor de rastreamento',
      );
    }
    const porNome = (nome: string) => configurados.find((p) => p.nome === nome);
    const memoria = await this.veiculos.memoriaDeProvedor(consulta.chassi);
    const plano = planejarSondagem(
      memoria,
      configurados.map((p) => p.nome),
      CONFIG_DA_POSICAO.limiteDeFalhas,
    );

    const rodada = new Rodada((provedor) =>
      this.consultarUm(provedor, consulta),
    );
    /** Rodada completa: todos os configurados foram consultados. */
    let completa = false;
    /** O provedor conhecido respondeu dentro do prazo dele. */
    let conhecidoRespondeu = false;

    if (plano.tipo === 'todos') {
      rodada.iniciar(configurados);
      await rodada.aguardar(CONFIG_DA_POSICAO.prazoDaSondagemMs);
      await rodada.aguardarPrimeiraPosicao();
      completa = true;
    } else {
      const demais = plano.demais
        .map(porNome)
        .filter((p): p is ProvedorDeRastreamento => !!p);
      rodada.iniciar([porNome(plano.provedor)!]);
      await rodada.aguardar(CONFIG_DA_POSICAO.prazoDoConhecidoMs);
      const doConhecido = rodada.desfecho(plano.provedor);

      if (!doConhecido?.ok) {
        // O provedor do veículo falhou (ou não respondeu a tempo): conta a
        // falha e pergunta aos demais nesta mesma consulta.
        await this.veiculos.registrarFalhaDoProvedor(
          consulta.chassi,
          plano.provedor,
        );
        rodada.iniciar(demais);
        await rodada.aguardar(CONFIG_DA_POSICAO.prazoDaSondagemMs);
        await rodada.aguardarPrimeiraPosicao();
      } else {
        conhecidoRespondeu = true;
        if (
          precisaRevalidar(
            {
              agora: Date.now(),
              verificadoEm: memoria?.verificadoEm ?? null,
              timestampDaPosicao: doConhecido.candidato.timestamp,
            },
            CONFIG_DA_POSICAO.janelas,
          )
        ) {
          rodada.iniciar(demais);
          await rodada.aguardar(CONFIG_DA_POSICAO.prazoDaSondagemMs);
          completa = true;
        }
      }
    }

    for (const nome of rodada.foraDoPrazo()) {
      this.logger.warn(
        `${baseTag(consulta.base)} provedor ${nome} fora da rodada por prazo (chassi ${consulta.chassi})`,
      );
    }

    // No empate de instante vence quem vem antes no registro de provedores.
    const ordem = new Map(this.provedores.map((p, i) => [p.nome, i]));
    const candidatos = rodada
      .candidatos()
      .sort((a, b) => ordem.get(a.origem)! - ordem.get(b.origem)!);
    const escolhido = escolherPosicao(candidatos);
    if (!escolhido) {
      throw new Error('Nenhum provedor de rastreamento retornou dados válidos');
    }

    if (completa) {
      await this.veiculos.gravarProvedor(
        consulta.chassi,
        escolhido.origem,
        new Date(),
      );
    } else if (
      conhecidoRespondeu &&
      plano.tipo === 'conhecido' &&
      (memoria?.falhas ?? 0) > 0
    ) {
      await this.veiculos.zerarFalhasDoProvedor(
        consulta.chassi,
        plano.provedor,
      );
    }

    this.logger.debug(
      `${baseTag(consulta.base)} posição do chassi ${consulta.chassi}: ${escolhido.origem} (${new Date(escolhido.timestamp).toISOString()}); candidatos: ${candidatos.map((c) => c.origem).join(', ')}`,
    );

    const resposta = escolhido.provedor.finalizarResposta
      ? await escolhido.provedor.finalizarResposta(
          escolhido.posicao,
          consulta.base,
        )
      : escolhido.posicao.resposta;
    return { ...resposta, origem: escolhido.origem };
  }

  /**
   * Consulta um provedor. Nunca rejeita: a falha vira um desfecho da rodada
   * (o provedor fica fora dela) e o detalhe vai para o log.
   */
  private async consultarUm(
    provedor: ProvedorDeRastreamento,
    consulta: ConsultaDePosicao,
  ): Promise<Desfecho> {
    try {
      const posicao = await provedor.obterUltimaPosicao(consulta);
      if (posicao.timestamp === null) {
        this.logger.warn(
          `Provider ${provedor.nome} ignorado por data inválida no rastreamento: ${String(posicao.dataDaPosicao)}`,
        );
        return { ok: false, motivo: 'data inválida' };
      }
      return {
        ok: true,
        candidato: {
          origem: provedor.nome,
          timestamp: posicao.timestamp,
          posicao,
          provedor,
        },
      };
    } catch (erro) {
      const motivo = this.descreverErro(erro);
      this.logger.warn(
        `Falha no rastreamento ${provedor.nome} para chassi ${consulta.chassi}: ${motivo}`,
      );
      return { ok: false, motivo };
    }
  }

  private descreverErro(erro: unknown): string {
    if (ehErroHttp(erro)) {
      return `HTTP ${erro.response?.status ?? 'N/A'} | URL: ${erro.config?.url ?? 'N/A'} | Body: ${JSON.stringify(erro.response?.data ?? null)}`;
    }
    return erro instanceof Error ? erro.message : String(erro);
  }
}
