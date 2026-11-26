import { Injectable, Logger } from '@nestjs/common';
import type { BaseOrigin } from 'src/config/tenant.config';
import {
  coordenadasDaPosicao,
  timestampDaPosicao,
} from 'src/rastreamento/domain/posicao';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';
import {
  ConsultaDePosicao,
  PosicaoDoProvedor,
  ProvedorDeRastreamento,
} from 'src/rastreamento/providers/rastreamento-provider.interface';
import { UltimaPosicaoSoftruckResponse } from 'src/rastreamento/softruck/dto/ultima-posicao.dto';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { SoftruckCredenciais } from 'src/rastreamento/softruck/services/softruck-credenciais';

/**
 * Posição da Softruck no formato unificado que o app espera na rota
 * `/rastreamento`: os campos da Softruck mais os nomes usados pelos outros
 * provedores (`placa`, `data_gps`, `velocidade`...).
 */
function paraRespostaUnificada(
  softruck: UltimaPosicaoSoftruckResponse,
): Record<string, unknown> {
  return {
    ...softruck,
    placa: softruck.plate,
    marca: softruck.brandName,
    modelo: softruck.modelName,
    ultimaTrasmissao: softruck.date,
    data_gps: softruck.date,
    velocidade: softruck.speed,
    ignicao: softruck.ign ?? false,
    condutorNome: null,
    alertaIgnicao: false,
    cidade: null,
    endereco: softruck.endereco ?? null,
    bairro: null,
    estado: null,
    direcao: null,
    hodometro: null,
    voltagem: softruck.voltagem ?? null,
    identificador: softruck.plate,
  };
}

/**
 * Softruck como provedor de posição. Resolve a própria chave pública na hora
 * da chamada e, quando vence a rodada, completa o endereço pela
 * geocodificação reversa local.
 */
@Injectable()
export class ProvedorSoftruck implements ProvedorDeRastreamento {
  readonly nome = 'softruck';
  private readonly logger = new Logger(ProvedorSoftruck.name);

  constructor(
    private readonly softruck: RastreamentoSoftruck,
    private readonly credenciais: SoftruckCredenciais,
    private readonly reverseGeocode: M7ReverseGeocodeService,
  ) {}

  estaConfigurado(base: BaseOrigin): boolean {
    return this.credenciais.estaConfigurada(base);
  }

  async obterUltimaPosicao(
    consulta: ConsultaDePosicao,
  ): Promise<PosicaoDoProvedor> {
    const posicao = await this.softruck.ultimaPosicaoSoftruck(
      consulta.chassi,
      consulta.base,
      this.credenciais.chavePublica(consulta.base),
      undefined,
      // O endereço só é buscado se a Softruck vencer (`finalizarResposta`).
      false,
    );

    return {
      origem: this.nome,
      dataDaPosicao: posicao.date ?? null,
      timestamp: timestampDaPosicao(posicao.date),
      coordenadas: coordenadasDaPosicao(posicao.latitude, posicao.longitude),
      resposta: paraRespostaUnificada(posicao),
    };
  }

  async finalizarResposta(
    posicao: PosicaoDoProvedor,
    base: BaseOrigin,
  ): Promise<Record<string, unknown>> {
    const lat = this.reverseGeocode.normalizarCoordenada(
      posicao.resposta.latitude as number | string | undefined,
    );
    const lon = this.reverseGeocode.normalizarCoordenada(
      posicao.resposta.longitude as number | string | undefined,
    );
    if (!lat || !lon) return posicao.resposta;

    let endereco: string | null;
    try {
      endereco = await this.reverseGeocode.reverseGeocodeCoordenada(
        lat,
        lon,
        base,
      );
    } catch (erro) {
      // A posição é o que importa: sem geocodificação, ela sai sem endereço.
      this.logger.warn(
        `[${base}] Reverse geocode falhou para o vencedor ${this.nome}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return posicao.resposta;
    }

    return endereco && endereco !== `${lat}, ${lon}`
      ? { ...posicao.resposta, endereco }
      : posicao.resposta;
  }
}
