import { Injectable } from '@nestjs/common';
import type { BaseOrigin } from 'src/config/tenant.config';
import { UltimaPosicaoLogicaResponse } from 'src/rastreamento/logica/services/rastreamento.logica';
import { AncoraM7Response } from 'src/rastreamento/m7/services/rastreamento-m7';
import { RastreamentoBaseContext } from 'src/rastreamento/providers/rastreamento-provider.interface';
import {
  AutorDoComando,
  ComandosVeiculoService,
} from 'src/rastreamento/services/comandos-veiculo.service';
import {
  ConsultarPosicaoService,
  RespostaDePosicao,
} from 'src/rastreamento/services/consultar-posicao.service';
import { ConsultasPorProvedorService } from 'src/rastreamento/services/consultas-por-provedor.service';
import { ProcessarWebhookM7Service } from 'src/rastreamento/services/processar-webhook-m7.service';
import { HistoricoRotasResponseDto } from 'src/rastreamento/softruck/dto/historico-response.dto';
import { UltimaPosicaoSoftruckResponse } from 'src/rastreamento/softruck/dto/ultima-posicao.dto';

/** Token sem associado identificado (chamada interna, token do painel). */
const SEM_AUTOR: AutorDoComando = { userId: null };

/**
 * Fachada do rastreamento: os métodos que os controllers e o
 * `WebhookProcessor` chamam, cada um delegando ao caso de uso dele.
 *
 * - posição unificada ........ `ConsultarPosicaoService`
 * - âncora e ignição ......... `ComandosVeiculoService`
 * - webhook da M7 ............ `ProcessarWebhookM7Service`
 * - rotas de um provedor só .. `ConsultasPorProvedorService`
 *
 * Nenhuma regra mora aqui; código novo nasce no caso de uso.
 */
@Injectable()
export class RastreamentoService {
  constructor(
    private readonly posicao: ConsultarPosicaoService,
    private readonly comandos: ComandosVeiculoService,
    private readonly webhook: ProcessarWebhookM7Service,
    private readonly porProvedor: ConsultasPorProvedorService,
  ) {}

  /** Posição mais recente entre os provedores (rota principal do app). */
  rastreamento(
    cnpj: string,
    chassi: string,
    requestContext?: RastreamentoBaseContext,
  ): Promise<RespostaDePosicao> {
    return this.posicao.executar(cnpj, chassi, requestContext?.baseOrigin);
  }

  ultimaPosicaoM7(cnpj: string, chassi: string, baseOrigin: BaseOrigin) {
    return this.porProvedor.ultimaPosicaoM7(cnpj, chassi, baseOrigin);
  }

  ultimaPosicaoLogica(
    chassi: string,
    token?: string,
    context?: { baseOrigin?: BaseOrigin; tokenKey?: string },
  ): Promise<UltimaPosicaoLogicaResponse> {
    return this.porProvedor.ultimaPosicaoLogica(chassi, token, context);
  }

  ultimaPosicaoSoftruck(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey?: string,
    tokenOverride?: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    return this.porProvedor.ultimaPosicaoSoftruck(
      chassi,
      baseOrigin,
      publicKey,
      tokenOverride,
    );
  }

  gerarRelatorioHistoricoSoftruckPDF(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey?: string,
  ): Promise<Buffer> {
    return this.porProvedor.relatorioHistoricoSoftruckPdf(
      chassi,
      dataInicial,
      dataFinal,
      baseOrigin,
      publicKey,
    );
  }

  obterRotasHistoricoSoftruck(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey?: string,
  ): Promise<HistoricoRotasResponseDto> {
    return this.porProvedor.rotasHistoricoSoftruck(
      chassi,
      dataInicial,
      dataFinal,
      baseOrigin,
      publicKey,
    );
  }

  ancoraM7(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    baseOrigin: BaseOrigin,
    autor: AutorDoComando = SEM_AUTOR,
  ): Promise<AncoraM7Response> {
    return this.comandos.ancora(cnpj, chassi, ancoraAtiva, baseOrigin, autor);
  }

  ignicaoM7(
    cnpj: string,
    chassi: string,
    evtIgn: boolean,
    baseOrigin: BaseOrigin,
    autor: AutorDoComando = SEM_AUTOR,
  ): Promise<AncoraM7Response> {
    return this.comandos.ignicao(cnpj, chassi, evtIgn, baseOrigin, autor);
  }

  getAncoraStatus(
    chassi: string,
    autor: AutorDoComando = SEM_AUTOR,
  ): Promise<{ ancoraAtiva: boolean; userId: number | null }> {
    return this.comandos.statusDaAncora(chassi, autor);
  }

  getIgnicaoStatus(
    chassi: string,
    autor: AutorDoComando = SEM_AUTOR,
  ): Promise<{ notificacaoIgnicao: boolean; userId: number | null }> {
    return this.comandos.statusDaIgnicao(chassi, autor);
  }

  renovarTokenM7() {
    return this.porProvedor.renovarTokenM7();
  }

  processarWebhookM7(payload: unknown) {
    return this.webhook.executar(payload);
  }
}
