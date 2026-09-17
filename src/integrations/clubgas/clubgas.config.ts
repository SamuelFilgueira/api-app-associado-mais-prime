import { Logger } from '@nestjs/common';

/**
 * Configuração do client ClubGas.
 *
 * - CLUBGAS_BASE_URL: base da API (default: produção). O ambiente de testes
 *   da ClubGas é `https://tst-clubgas-api.azurewebsites.net/api/v1`.
 * - CLUBGAS_TEST_PLACA / CLUBGAS_TEST_CPF: **somente ambiente de teste**.
 *   Quando definidas, substituem placa e CPF do usuário logado em TODAS as
 *   chamadas à ClubGas (a homologação deles exige um associado fixo que não
 *   existe na nossa base). Latitude/longitude continuam vindo do aparelho.
 *   Ausentes (produção, Mais Prime) = comportamento original.
 */
export interface ClubgasConfig {
  baseUrl: string;
  testPlaca: string | null;
  testCpf: string | null;
  modoTeste: boolean;
}

export const CLUBGAS_BASE_URL_PRODUCAO =
  'https://clubgas-api.azurewebsites.net/api/v1';

function envOuNull(nome: string): string | null {
  const valor = process.env[nome]?.trim();
  return valor ? valor : null;
}

export function carregarClubgasConfig(): ClubgasConfig {
  const logger = new Logger('ClubgasConfig');

  const baseUrl = (
    process.env.CLUBGAS_BASE_URL?.trim() || CLUBGAS_BASE_URL_PRODUCAO
  ).replace(/\/+$/, '');
  const testPlaca = envOuNull('CLUBGAS_TEST_PLACA');
  const testCpf = envOuNull('CLUBGAS_TEST_CPF');
  const modoTeste = testPlaca !== null || testCpf !== null;

  if (modoTeste) {
    logger.warn(
      `MODO TESTE CLUBGAS ativo — placa/CPF substituídos em todas as chamadas ` +
        `(placa=${testPlaca ?? 'do usuário'}, cpf=${testCpf ? '***' + testCpf.slice(-4) : 'do usuário'}, base=${baseUrl}). ` +
        'Remova CLUBGAS_TEST_PLACA/CLUBGAS_TEST_CPF em produção.',
    );
  }

  return { baseUrl, testPlaca, testCpf, modoTeste };
}
