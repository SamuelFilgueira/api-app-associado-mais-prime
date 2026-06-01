import { BaseOrigin } from 'src/shared/token-resolver.service';

export interface RastreamentoBaseContext {
  baseOrigin: BaseOrigin;
  logicaToken: string;
  logicaTokenKey: string;
  softruckPublicKey: string;
}

export interface RastreamentoCandidatoResult {
  dataOriginal: string;
  timestamp: number;
  data: Record<string, unknown>;
  origem: 'm7' | 'logica' | 'softruck';
}

export interface IRastreamentoProvider {
  readonly providerName: 'm7' | 'logica' | 'softruck';
  obterUltimaPosicao(params: {
    cnpj: string;
    chassi: string;
    baseContext: RastreamentoBaseContext;
  }): Promise<RastreamentoCandidatoResult>;
}

export const RASTREAMENTO_PROVIDERS = Symbol('RASTREAMENTO_PROVIDERS');
