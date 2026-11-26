import { InternalServerErrorException } from '@nestjs/common';

const MENSAGEM_NEUTRA =
  'Rastreamento indisponível no momento. Tente novamente em instantes.';

/**
 * 500 com mensagem neutra e `code` estável, para as falhas em que o texto
 * antigo levava ao app o nome de uma variável de ambiente ou a mensagem crua
 * do provedor. O status continua o de sempre (500); o detalhe fica no log de
 * quem lança.
 *
 * O corpo mantém o formato do Nest (`statusCode`, `message`, `error`) e
 * ganha `code`, campo aditivo.
 */
export function erroInternoDeRastreamento(
  code: string,
  mensagem: string = MENSAGEM_NEUTRA,
): InternalServerErrorException {
  return new InternalServerErrorException({
    statusCode: 500,
    message: mensagem,
    error: 'Internal Server Error',
    code,
  });
}
