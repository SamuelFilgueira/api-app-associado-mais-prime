import { Injectable } from '@nestjs/common';
import type { BaseOrigin } from 'src/config/tenant.config';
import {
  coordenadasDaPosicao,
  timestampDaPosicao,
} from 'src/rastreamento/domain/posicao';
import { M7AuthService } from 'src/rastreamento/m7/services/m7-auth.service';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import {
  ConsultaDePosicao,
  PosicaoDoProvedor,
  ProvedorDeRastreamento,
} from 'src/rastreamento/providers/rastreamento-provider.interface';

/**
 * M7 como provedor de posição. A resposta vai ao app no formato da própria
 * M7 (o campo `cidade` é o original, sem geocodificação reversa).
 */
@Injectable()
export class ProvedorM7 implements ProvedorDeRastreamento {
  readonly nome = 'm7';

  constructor(
    private readonly m7: RastreamentoM7,
    private readonly auth: M7AuthService,
  ) {}

  estaConfigurado(base: BaseOrigin): boolean {
    return this.auth.estaConfigurada(base);
  }

  async obterUltimaPosicao(
    consulta: ConsultaDePosicao,
  ): Promise<PosicaoDoProvedor> {
    const posicao = await this.m7.ultimaPosicaoM7(
      consulta.cnpj,
      consulta.chassi,
      consulta.base,
      false,
    );

    const bruto = posicao as unknown as {
      data_gps?: unknown;
      ultima_posicao?: { data_gps?: unknown };
    };
    const dataDaPosicao =
      typeof bruto.data_gps === 'string'
        ? bruto.data_gps
        : typeof bruto.ultima_posicao?.data_gps === 'string'
          ? bruto.ultima_posicao.data_gps
          : null;

    return {
      origem: this.nome,
      dataDaPosicao,
      timestamp: timestampDaPosicao(dataDaPosicao),
      coordenadas: coordenadasDaPosicao(posicao.latitude, posicao.longitude),
      resposta: posicao as unknown as Record<string, unknown>,
    };
  }
}
