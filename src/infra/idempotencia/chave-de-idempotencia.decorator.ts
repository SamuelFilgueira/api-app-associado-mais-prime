import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * Valor do header `Idempotency-Key` (ou `undefined`). O handler repassa ao
 * `IdempotenciaService.executar`.
 */
export const ChaveDeIdempotencia = createParamDecorator(
  (_dados: unknown, contexto: ExecutionContext): string | undefined => {
    const req = contexto
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const valor = req.headers['idempotency-key'];
    const chave = Array.isArray(valor) ? valor[0] : valor;
    return typeof chave === 'string' && chave.trim() ? chave.trim() : undefined;
  },
);
