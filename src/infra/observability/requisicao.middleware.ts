import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  contextoExecucao,
  normalizarRequestId,
} from 'src/infra/observability/contexto-execucao';
import { metricas } from 'src/infra/observability/metricas';

const logger = new Logger('HTTP');

/** Rotas de sonda: não entram no log de acesso (uma linha a cada poucos segundos). */
const ROTAS_SILENCIOSAS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/metrics',
]);

interface UsuarioDaRequisicao {
  userId?: number | string;
  baseOrigin?: string;
}

/**
 * Primeiro middleware da cadeia. Para cada requisição:
 *
 * 1. Aceita o `X-Request-Id` do proxy (ou gera um) e o devolve na resposta.
 * 2. Abre o contexto de execução (`AsyncLocalStorage`), que carimba toda
 *    linha de log da requisição.
 * 3. No `finish`, registra a linha de acesso e as métricas HTTP — com o
 *    status final, inclusive quando um guard barrou a requisição (caso que um
 *    interceptor não enxerga).
 *
 * A linha de acesso usa a rota em template (`/api/associado/:id`) e não a
 * URL: sem query string e sem CPF/chassi no caminho.
 */
export function requisicaoMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = normalizarRequestId(req.headers['x-request-id']);
  const inicio = process.hrtime.bigint();
  res.setHeader('X-Request-Id', requestId);

  contextoExecucao.executar({ requestId }, () => {
    const contexto = contextoExecucao.atual();

    res.on('finish', () => {
      const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
      const rota = rotaEmTemplate(req);
      const status = res.statusCode;
      const usuario = (req as Request & { user?: UsuarioDaRequisicao }).user;

      const rotulos = {
        method: req.method,
        route: rota,
        status: String(status),
      };
      metricas.httpRequisicoes.inc(rotulos);
      metricas.httpDuracao.observe(rotulos, segundos);

      if (ROTAS_SILENCIOSAS.has(rota)) return;

      const linha = {
        evento: 'http_request',
        method: req.method,
        rota,
        status,
        duracaoMs: Math.round(segundos * 1000),
        userId: usuario?.userId ?? contexto?.userId,
        base: usuario?.baseOrigin ?? contexto?.base,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        bytes: Number(res.getHeader('content-length')) || undefined,
      };

      // Reabre o contexto: o `finish` dispara fora da cadeia assíncrona original.
      contextoExecucao.executar(
        {
          ...contexto,
          requestId,
          rota,
          userId: linha.userId,
          base: linha.base,
        },
        () => {
          if (status >= 500) logger.error(linha);
          else if (status >= 400) logger.warn(linha);
          else logger.log(linha);
        },
      );
    });

    next();
  });
}

/**
 * Rota em template. Requisição que não casou com nenhum handler vira
 * `nao_mapeada`: usar o caminho cru criaria uma série de métrica por URL
 * varrida por scanner.
 */
export function rotaEmTemplate(req: Request): string {
  const rota = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof rota === 'string') {
    return `${req.baseUrl ?? ''}${rota}` || '/';
  }
  if (req.path.startsWith('/uploads/')) return '/uploads/*';
  return 'nao_mapeada';
}
