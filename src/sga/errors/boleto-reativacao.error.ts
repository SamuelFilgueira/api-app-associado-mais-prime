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

/**
 * O SGA cadastrou o boleto, mas a gravação local (`ReinspectionPayment`)
 * falhou. O boleto EXISTE: quem captura grava o `nossoNumero` na revistoria
 * e a tentativa seguinte retoma dele — nunca cadastra outro.
 */
export class BoletoCadastradoSemRegistroError extends Error {
  constructor(
    public readonly boleto: {
      nossoNumero: string | null;
      linhaDigitavel: string | null;
      linkBoleto: string | null;
    },
    public readonly causa: unknown,
  ) {
    super(
      `boleto ${boleto.nossoNumero ?? '(sem nosso_numero)'} cadastrado no SGA, mas a gravação local falhou: ${causa instanceof Error ? causa.message : String(causa)}`,
    );
    this.name = 'BoletoCadastradoSemRegistroError';
  }
}
