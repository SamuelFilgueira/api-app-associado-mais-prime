import { Logger } from '@nestjs/common';
import { metricas } from 'src/infra/observability/metricas';
import { IntegrationError } from 'src/shared/erros/erros';

export interface OpcoesDoDisjuntor {
  /** Falhas consecutivas que abrem o circuito. */
  falhasParaAbrir?: number;
  /** Quanto o circuito fica aberto antes de deixar passar uma sonda. */
  abertoPorMs?: number;
}

type Estado = 'fechado' | 'aberto' | 'meio_aberto';

interface Circuito {
  estado: Estado;
  falhas: number;
  abertoAte: number;
  sondaEmCurso: boolean;
}

const VALOR_DO_ESTADO: Record<Estado, number> = {
  fechado: 0,
  meio_aberto: 0.5,
  aberto: 1,
};

/**
 * Circuit breaker por vendor e base.
 *
 * Com o vendor fora, cada requisição do app esperava o timeout inteiro
 * (45 s no SGA) antes de falhar, segurando conexão e pool. Depois de
 * `falhasParaAbrir` falhas seguidas o circuito abre e as chamadas falham na
 * hora (`IntegrationError` do tipo `circuito_aberto`, HTTP 503). Passado
 * `abertoPorMs`, UMA chamada passa como sonda: se der certo o circuito fecha,
 * se falhar abre de novo.
 *
 * Só falha de transporte conta (timeout, rede, 5xx). Resposta de negócio do
 * vendor, inclusive 4xx, mostra que ele está de pé — quem decide é o
 * chamador, em `ehFalha`.
 *
 * O estado é por processo: cada réplica descobre a queda sozinha em poucas
 * chamadas, e não há o que coordenar.
 */
export class Disjuntor {
  private readonly logger = new Logger('Disjuntor');
  private readonly circuitos = new Map<string, Circuito>();
  private readonly falhasParaAbrir: number;
  private readonly abertoPorMs: number;

  constructor(
    private readonly vendor: string,
    opcoes: OpcoesDoDisjuntor = {},
  ) {
    this.falhasParaAbrir = opcoes.falhasParaAbrir ?? 5;
    this.abertoPorMs = opcoes.abertoPorMs ?? 30_000;
  }

  /**
   * Executa a chamada pelo circuito da base.
   *
   * @param ehFalha decide se o RESULTADO (resposta resolvida) conta como
   *        falha do vendor — por exemplo, um 5xx com `validateStatus` aberto.
   *        Exceção sempre conta.
   */
  async executar<T>(
    base: string,
    chamada: () => Promise<T>,
    ehFalha: (resultado: T) => boolean = () => false,
  ): Promise<T> {
    const circuito = this.circuito(base);
    const agora = Date.now();

    if (circuito.estado === 'aberto') {
      if (agora < circuito.abertoAte) throw this.erroAberto(base, circuito);
      this.mudar(base, circuito, 'meio_aberto');
    }
    if (circuito.estado === 'meio_aberto') {
      if (circuito.sondaEmCurso) throw this.erroAberto(base, circuito);
      circuito.sondaEmCurso = true;
    }

    try {
      const resultado = await chamada();
      if (ehFalha(resultado)) this.registrarFalha(base, circuito);
      else this.registrarSucesso(base, circuito);
      return resultado;
    } catch (erro) {
      this.registrarFalha(base, circuito);
      throw erro;
    } finally {
      circuito.sondaEmCurso = false;
    }
  }

  estado(base: string): Estado {
    return this.circuito(base).estado;
  }

  private registrarSucesso(base: string, circuito: Circuito): void {
    circuito.falhas = 0;
    if (circuito.estado !== 'fechado') this.mudar(base, circuito, 'fechado');
  }

  private registrarFalha(base: string, circuito: Circuito): void {
    circuito.falhas += 1;
    if (
      circuito.estado === 'meio_aberto' ||
      circuito.falhas >= this.falhasParaAbrir
    ) {
      circuito.abertoAte = Date.now() + this.abertoPorMs;
      this.mudar(base, circuito, 'aberto');
    }
  }

  private mudar(base: string, circuito: Circuito, estado: Estado): void {
    if (circuito.estado === estado) return;
    circuito.estado = estado;
    metricas.vendorCircuito.set(
      { vendor: this.vendor, base },
      VALOR_DO_ESTADO[estado],
    );
    const texto = `Circuito ${this.vendor}/${base}: ${estado.replace('_', '-')}`;
    if (estado === 'aberto') {
      this.logger.error(
        `${texto} após ${circuito.falhas} falha(s) seguida(s); chamadas falham na hora por ${this.abertoPorMs / 1000}s.`,
      );
    } else {
      this.logger.warn(texto);
    }
  }

  private erroAberto(base: string, circuito: Circuito): IntegrationError {
    metricas.vendorRequisicoes.inc({
      vendor: this.vendor,
      base,
      operacao: 'n/a',
      resultado: 'circuito_aberto',
    });
    return new IntegrationError({
      vendor: this.vendor,
      base,
      tipo: 'circuito_aberto',
      detalhes: { abertoPorMs: Math.max(0, circuito.abertoAte - Date.now()) },
    });
  }

  private circuito(base: string): Circuito {
    let circuito = this.circuitos.get(base);
    if (!circuito) {
      circuito = {
        estado: 'fechado',
        falhas: 0,
        abertoAte: 0,
        sondaEmCurso: false,
      };
      this.circuitos.set(base, circuito);
      metricas.vendorCircuito.set({ vendor: this.vendor, base }, 0);
    }
    return circuito;
  }
}
