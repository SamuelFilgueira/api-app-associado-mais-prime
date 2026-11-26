import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { BaseOrigin } from 'src/config/tenant.config';
import { metricas } from 'src/infra/observability/metricas';
import { TravaService } from 'src/infra/redis/trava.service';
import {
  EstadoDoVeiculo,
  estadoEfetivo,
  lerBooleanoDeEntrada,
} from 'src/rastreamento/domain/estado-veiculo';
import {
  AncoraM7Response,
  RastreamentoM7,
} from 'src/rastreamento/m7/services/rastreamento-m7';
import {
  VeiculoRastreamentoRepository,
  VinculoDoVeiculo,
} from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import { garantirRastreamentoLiberado } from 'src/rastreamento/services/rastreamento-liberado';
import { DomainError, InfraError } from 'src/shared/erros/erros';
import { exigirBase } from 'src/shared/tenant/tenant-context';

/**
 * Quem pediu o comando. `userId` é `null` quando o token não é de um
 * associado (token do painel): o id dele não é um id de `user` e vai em
 * `painelUserId`, só para a auditoria.
 */
export interface AutorDoComando {
  userId: number | null;
  painelUserId?: number | null;
}

type Comando = 'ANCORA' | 'IGNICAO';

interface PedidoDeComando {
  tipo: Comando;
  /** Valor que vai à M7. */
  enviado: unknown;
  /** O mesmo valor como booleano; `null` se o app mandou algo não reconhecido. */
  valor: boolean | null;
}

/** Trava curta por chassi; é renovada enquanto o comando roda. */
const TTL_DA_TRAVA_MS = 10_000;
/** Quanto esperar por outro comando do mesmo veículo antes de desistir. */
const ESPERA_DA_TRAVA_MS = 20_000;
const INTERVALO_DA_ESPERA_MS = 200;

const esperar = (ms: number) =>
  new Promise<void>((resolver) => setTimeout(resolver, ms));

/**
 * Âncora e alerta de ignição (comandos na M7) e a consulta do estado.
 *
 * O estado é do VEÍCULO (`UserVehicle.ancoraAtiva` / `notificacaoIgnicao`).
 * Antes ficava no usuário: mexer no carro B reaplicava nele a âncora do
 * carro A. As colunas do usuário continuam sendo escritas para quem ainda as
 * lê, com o agregado dos veículos.
 *
 * Sem checagem de posse: o vínculo do usuário logado só tem preferência
 * quando existe; chassi sem vínculo local segue como sempre (estado lido na
 * M7, comando enviado, nada gravado).
 */
@Injectable()
export class ComandosVeiculoService {
  private readonly logger = new Logger(ComandosVeiculoService.name);

  constructor(
    private readonly veiculos: VeiculoRastreamentoRepository,
    private readonly m7: RastreamentoM7,
    private readonly trava: TravaService,
  ) {}

  async ancora(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    baseOrigin: BaseOrigin,
    autor: AutorDoComando,
  ): Promise<AncoraM7Response> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    // A âncora vai à M7 como o app mandou (sempre foi assim); para gravar,
    // só vale o que for reconhecido como booleano.
    const ligada = lerBooleanoDeEntrada(ancoraAtiva);
    return this.sobTravaDoVeiculo(chassi, () =>
      this.executar(
        { tipo: 'ANCORA', enviado: ancoraAtiva, valor: ligada },
        cnpj,
        chassi,
        baseOrigin,
        autor,
      ),
    );
  }

  async ignicao(
    cnpj: string,
    chassi: string,
    evtIgn: unknown,
    baseOrigin: BaseOrigin,
    autor: AutorDoComando,
  ): Promise<AncoraM7Response> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    const ligado = lerBooleanoDeEntrada(evtIgn);
    if (ligado === null) {
      throw new BadRequestException(
        'Campo evt_ign inválido. Use true/false ou 1/0.',
      );
    }
    return this.sobTravaDoVeiculo(chassi, () =>
      this.executar(
        { tipo: 'IGNICAO', enviado: ligado, valor: ligado },
        cnpj,
        chassi,
        baseOrigin,
        autor,
      ),
    );
  }

  /** Estado da âncora do veículo; sem vínculo local, `false` e `null`. */
  async statusDaAncora(
    chassi: string,
    autor: AutorDoComando,
  ): Promise<{ ancoraAtiva: boolean; userId: number | null }> {
    const vinculo = await this.veiculos.vinculo(chassi, autor.userId);
    if (!vinculo) return { ancoraAtiva: false, userId: null };
    return {
      ancoraAtiva: estadoEfetivo(vinculo.veiculo, vinculo.usuario).ancoraAtiva,
      userId: vinculo.userId,
    };
  }

  /** Estado do alerta de ignição; só considera veículo e dono ativos. */
  async statusDaIgnicao(
    chassi: string,
    autor: AutorDoComando,
  ): Promise<{ notificacaoIgnicao: boolean; userId: number | null }> {
    const normalizado = chassi?.trim();
    if (!normalizado) throw new BadRequestException('Chassi é obrigatório');

    const vinculo = await this.veiculos.vinculo(normalizado, autor.userId, {
      somenteAtivos: true,
    });
    if (!vinculo) return { notificacaoIgnicao: false, userId: null };
    return {
      notificacaoIgnicao: estadoEfetivo(vinculo.veiculo, vinculo.usuario)
        .notificacaoIgnicao,
      userId: vinculo.userId,
    };
  }

  // ------------------------------------------------------------------

  /**
   * Um comando: lê o estado atual do veículo, envia os DOIS campos à M7 (ela
   * exige ambos; mandar só um zeraria o outro), grava o resultado no veículo
   * e registra a linha de auditoria (OK ou FALHA).
   */
  private async executar(
    pedido: PedidoDeComando,
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
    autor: AutorDoComando,
  ): Promise<AncoraM7Response> {
    const comando = pedido.tipo;
    const vinculo = await this.veiculos.vinculo(chassi, autor.userId);
    const atual = await this.estadoAtual(vinculo, cnpj, chassi, baseOrigin);
    const novo: EstadoDoVeiculo =
      comando === 'ANCORA'
        ? { ...atual, ancoraAtiva: pedido.valor ?? atual.ancoraAtiva }
        : {
            ...atual,
            notificacaoIgnicao: pedido.valor ?? atual.notificacaoIgnicao,
          };

    const registro = {
      userId: autor.userId,
      adminPanelUserId: autor.painelUserId ?? null,
      userVehicleId: vinculo?.id ?? null,
      chassi,
      baseOrigin: baseOrigin ?? null,
      comando,
      valor: comando === 'ANCORA' ? novo.ancoraAtiva : novo.notificacaoIgnicao,
    };

    let resposta: AncoraM7Response;
    try {
      resposta =
        comando === 'ANCORA'
          ? await this.m7.ancoraM7(
              cnpj,
              chassi,
              pedido.enviado as boolean,
              atual.notificacaoIgnicao,
              baseOrigin,
            )
          : await this.m7.ignicaoM7(
              cnpj,
              chassi,
              pedido.enviado as boolean,
              atual.ancoraAtiva,
              baseOrigin,
            );
    } catch (erro) {
      await this.registrarFalha(registro, erro);
      throw erro;
    }

    if ('erro' in resposta) {
      // Contrato legado: a recusa da M7 volta ao app com status de sucesso.
      metricas.vendorErro200.inc({
        vendor: 'm7',
        rota: comando === 'ANCORA' ? 'ancora-m7' : 'ignicao-m7',
      });
      await this.veiculos.registrarComando({
        ...registro,
        resultado: 'FALHA',
        erro: String(resposta.erro),
      });
      return resposta;
    }

    if (!vinculo) {
      this.logger.warn(
        `Nenhum usuário encontrado para o chassi ${chassi} — estado de ${comando === 'ANCORA' ? 'âncora' : 'ignição'} não persistido`,
      );
      await this.veiculos.registrarComando({ ...registro, resultado: 'OK' });
      return resposta;
    }

    const gravou = await this.veiculos.gravarEstado(vinculo, novo, {
      ...registro,
      resultado: 'OK',
    });
    if (!gravou) {
      this.logger.warn(
        `Vínculo ${vinculo.id} do chassi ${chassi} não existe mais — estado não persistido`,
      );
    }
    return resposta;
  }

  /**
   * Estado atual do veículo: o do vínculo (veículo; se `null`, usuário). Sem
   * vínculo local, o estado real é lido na M7 — com a base da requisição,
   * nunca com a credencial de outra base.
   */
  private async estadoAtual(
    vinculo: VinculoDoVeiculo | null,
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<EstadoDoVeiculo> {
    if (vinculo) return estadoEfetivo(vinculo.veiculo, vinculo.usuario);

    this.logger.warn(
      `Estado do veículo não encontrado no banco para chassi=${chassi} — consultando API M7`,
    );
    const naM7 = await this.m7.getEventoPadraoM7(
      cnpj,
      chassi,
      exigirBase(baseOrigin, 'estado do veículo na M7'),
    );
    return { ancoraAtiva: naM7.ancoraAtiva, notificacaoIgnicao: naM7.evtIgn };
  }

  /**
   * Linha de FALHA quando a chamada à M7 lança. O erro da M7 é o que o
   * chamador recebe; se a própria auditoria falhar, isso vai para o log e o
   * erro original segue.
   */
  private async registrarFalha(
    registro: Omit<
      Parameters<VeiculoRastreamentoRepository['registrarComando']>[0],
      'resultado' | 'erro'
    >,
    erro: unknown,
  ): Promise<void> {
    try {
      await this.veiculos.registrarComando({
        ...registro,
        resultado: 'FALHA',
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    } catch (erroDaAuditoria) {
      this.logger.error(
        `Auditoria do comando ${registro.comando} (chassi ${registro.chassi}) não gravada: ${erroDaAuditoria instanceof Error ? erroDaAuditoria.message : String(erroDaAuditoria)}`,
      );
    }
  }

  /**
   * Um comando por vez por chassi: sem isso, dois comandos simultâneos leem o
   * mesmo estado e o segundo desfaz o primeiro na M7.
   *
   * - Outro comando em andamento: espera até `ESPERA_DA_TRAVA_MS`.
   * - Redis fora: o comando roda sem a trava. Âncora é recurso de segurança
   *   do associado; recusar por causa do Redis seria pior que a corrida.
   */
  private async sobTravaDoVeiculo<T>(
    chassi: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const chave = `rastreamento:comando:${String(chassi ?? '')
      .trim()
      .toUpperCase()}`;
    const prazo = Date.now() + ESPERA_DA_TRAVA_MS;

    for (;;) {
      let iniciou = false;
      try {
        const resultado = await this.trava.tentar(
          chave,
          TTL_DA_TRAVA_MS,
          () => {
            iniciou = true;
            return fn();
          },
        );
        if (resultado.executou) return resultado.valor;
      } catch (erro) {
        if (iniciou || !(erro instanceof InfraError)) throw erro;
        this.logger.warn(
          `Trava de comando indisponível (Redis); comando do chassi ${chassi} segue sem exclusão.`,
        );
        return fn();
      }

      if (Date.now() >= prazo) {
        throw new DomainError(
          'RASTREAMENTO_COMANDO_EM_ANDAMENTO',
          'Outro comando para este veículo está em andamento. Tente novamente em instantes.',
          { status: 409 },
        );
      }
      await esperar(INTERVALO_DA_ESPERA_MS);
    }
  }
}
