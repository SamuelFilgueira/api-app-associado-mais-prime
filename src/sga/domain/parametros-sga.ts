/**
 * Formato dos parâmetros que o app envia e que acabam em URL ou corpo de
 * requisição ao SGA. Tudo o que não casar é recusado na borda (400), antes
 * de qualquer consulta: um chassi com `/` ou `?` mudaria o caminho da chamada.
 */

/** Chassi: só letras e números, de 6 a 20 caracteres. */
export const CHASSI_REGEX = /^[A-Za-z0-9]{6,20}$/;

/** Códigos do SGA (veículo, associado): só dígitos. */
export const CODIGO_SGA_REGEX = /^\d{1,12}$/;

export function ehChassiValido(valor: unknown): valor is string {
  return typeof valor === 'string' && CHASSI_REGEX.test(valor.trim());
}

/**
 * Código numérico do SGA. O app manda `Number(codigo)`, mas o corpo não passa
 * por DTO: aceita inteiro positivo ou texto só de dígitos.
 */
export function ehCodigoSgaValido(valor: unknown): valor is number | string {
  if (typeof valor === 'number') {
    return Number.isSafeInteger(valor) && valor > 0;
  }
  return typeof valor === 'string' && CODIGO_SGA_REGEX.test(valor);
}
