import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Erros com `code`, no mesmo formato de `direct-partners`: o
 * filtro global (`AllExceptionsFilter`) devolve o objeto como enviado e o app decide a
 * mensagem pelo `code`.
 */
export function erro422(
  code: string,
  message: string,
  extra?: object,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    code,
    message,
    ...extra,
  });
}

export function erro409(
  code: string,
  message: string,
  extra?: object,
): ConflictException {
  return new ConflictException({ statusCode: 409, code, message, ...extra });
}

export function erro403(
  code: string,
  message: string,
  extra?: object,
): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code, message, ...extra });
}

export function erro429(message: string): HttpException {
  return new HttpException(
    { statusCode: 429, code: 'MUITAS_REQUISICOES', message },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function erro503(message: string): HttpException {
  return new HttpException(
    { statusCode: 503, code: 'TENTE_NOVAMENTE', message },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/** Código de negócio (`code`) de uma exceção, ou `null` se não houver. */
export function codigoDoErro(erro: unknown): string | null {
  if (erro instanceof HttpException) {
    const resposta = erro.getResponse();
    if (resposta && typeof resposta === 'object' && 'code' in resposta) {
      const code = (resposta as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return `HTTP_${erro.getStatus()}`;
  }
  return null;
}
