import type { BaseOrigin } from 'src/config/tenant.config';

/** Contexto que a borda (controller ou job) entrega ao rastreamento. */
export interface RastreamentoBaseContext {
  baseOrigin: BaseOrigin;
}

export interface ConsultaDePosicao {
  base: BaseOrigin;
  chassi: string;
  /** CPF/CNPJ do titular, exigido por alguns provedores. */
  cnpj: string;
}

/** Posição mais recente de um veículo, no envelope comum a todo provedor. */
export interface PosicaoDoProvedor {
  /** Nome do provedor que respondeu; vai ao app no campo `origem`. */
  origem: string;
  /** Data da posição como o provedor mandou. */
  dataDaPosicao: string | null;
  /** Instante da posição (ms); `null` quando a data não é reconhecida. */
  timestamp: number | null;
  coordenadas: { latitude: number; longitude: number } | null;
  /** Corpo que vai ao app quando este provedor vence a rodada. */
  resposta: Record<string, unknown>;
}

/**
 * Porta de um provedor de rastreamento (M7, Lógica, Softruck...).
 *
 * Cada provedor resolve a PRÓPRIA credencial pela base — quem chama só
 * informa base, chassi e documento. O orquestrador não conhece nenhuma
 * classe concreta: ele percorre o registro (`PROVEDORES_DE_RASTREAMENTO`).
 *
 * Provedor novo: implementar esta interface no submódulo dele, exportar a
 * classe e acrescentá-la à lista em `rastreamento.module.ts`. Nada mais muda.
 */
export interface ProvedorDeRastreamento {
  /** Identificador estável; é o valor gravado em `UserVehicle.provedorRastreamento`. */
  readonly nome: string;

  /** A base tem credencial deste provedor? Nunca lança. */
  estaConfigurado(base: BaseOrigin): boolean;

  /**
   * Posição mais recente do veículo. Rejeita quando o veículo não existe no
   * provedor, a base não tem credencial ou o vendor falha.
   */
  obterUltimaPosicao(consulta: ConsultaDePosicao): Promise<PosicaoDoProvedor>;

  /**
   * Acabamento opcional da resposta quando este provedor vence a rodada
   * (ex.: endereço por geocodificação reversa). Não deve derrubar a posição.
   */
  finalizarResposta?(
    posicao: PosicaoDoProvedor,
    base: BaseOrigin,
  ): Promise<Record<string, unknown>>;
}

/** Token de injeção do registro: a lista de provedores, em ordem de desempate. */
export const PROVEDORES_DE_RASTREAMENTO = Symbol('PROVEDORES_DE_RASTREAMENTO');
