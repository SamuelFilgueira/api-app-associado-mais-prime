import { Injectable } from '@nestjs/common';
import { BaseOrigin, isTenantBase } from 'src/config/tenant.config';
import {
  coordenadasDaPosicao,
  timestampDaPosicao,
} from 'src/rastreamento/domain/posicao';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';
import {
  ConsultaDePosicao,
  PosicaoDoProvedor,
  ProvedorDeRastreamento,
} from 'src/rastreamento/providers/rastreamento-provider.interface';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * Lógica Soluções como provedor de posição. Resolve a própria credencial (o
 * token inicial da base) na hora da chamada.
 */
@Injectable()
export class ProvedorLogica implements ProvedorDeRastreamento {
  readonly nome = 'logica';

  constructor(
    private readonly logica: LogicaRastreamentoService,
    private readonly credenciais: TenantCredentialsRegistry,
  ) {}

  estaConfigurado(base: BaseOrigin): boolean {
    if (!isTenantBase(base)) return false;
    return !this.credenciais.integracoesIncompletas(base).logica;
  }

  /** Credencial da Lógica para a base: o token e o nome dele no ambiente. */
  credencial(base: BaseOrigin): { token: string; tokenKey: string } {
    return {
      token: this.credenciais.logica(base).token,
      tokenKey: this.credenciais.nomeDaEnv(base, 'logica'),
    };
  }

  async obterUltimaPosicao(
    consulta: ConsultaDePosicao,
  ): Promise<PosicaoDoProvedor> {
    const { token, tokenKey } = this.credencial(consulta.base);
    const posicao = await this.logica.ultimaPosicao(consulta.chassi, token, {
      baseOrigin: consulta.base,
      tokenKey,
    });

    return {
      origem: this.nome,
      dataDaPosicao: posicao.ultimaTrasmissao ?? null,
      timestamp: timestampDaPosicao(posicao.ultimaTrasmissao),
      coordenadas: coordenadasDaPosicao(posicao.latitude, posicao.longitude),
      resposta: posicao as unknown as Record<string, unknown>,
    };
  }
}
