/**
 * Erros tipados da criação do boleto de reativação. Quem chama decide o que
 * fazer com cada um: instabilidade entra no retry; definitivo não.
 */

/** Falha temporária do SGA/rede: vale tentar de novo mais tarde. */
export class BoletoReativacaoInstabilidadeError extends Error {
  constructor(
    message: string,
    public readonly etapa: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'BoletoReativacaoInstabilidadeError';
  }
}

/** Falha que não muda com retry (dado ausente, veículo inexistente no SGA...). */
export class BoletoReativacaoDefinitivoError extends Error {
  constructor(
    message: string,
    public readonly etapa: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'BoletoReativacaoDefinitivoError';
  }
}
