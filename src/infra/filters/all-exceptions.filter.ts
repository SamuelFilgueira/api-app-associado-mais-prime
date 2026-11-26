import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { contextoExecucao } from 'src/infra/observability/contexto-execucao';
import { metricas } from 'src/infra/observability/metricas';
import {
  DomainError,
  ErroDeAplicacao,
  InfraError,
  IntegrationError,
} from 'src/shared/erros/erros';

const MSG_INDISPONIVEL =
  'Serviço temporariamente indisponível. Tente novamente em instantes.';

/** Códigos do Prisma que significam "o banco não está disponível agora". */
const PRISMA_INDISPONIVEL = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
]);

interface RespostaDeErro {
  status: number;
  corpo: Record<string, unknown>;
  nivel: 'error' | 'warn';
}

/**
 * Filtro global único. Substitui o `HttpExceptionFilter`, que só tratava
 * `HttpException` e deixava todo o resto sair sem `requestId`.
 *
 * Contrato: para `HttpException` o corpo é o mesmo de sempre
 * (`statusCode`, `message` e o que mais o código tiver posto), e o
 * `requestId` entra como campo aditivo. Para as famílias de
 * `ErroDeAplicacao` o corpo ganha `code`. Erro desconhecido vira 500 com a
 * mensagem padrão do Nest — o detalhe fica no log, com a stack.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Excecao');

  catch(excecao: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw excecao;
    }

    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const requestId = contextoExecucao.requestId();

    const { status, corpo, nivel } = this.traduzir(excecao);
    if (requestId) corpo.requestId = requestId;

    const rota =
      (request.route as { path?: string } | undefined)?.path ?? request.path;
    const resumo = `${request.method} ${rota} ${status} — ${mensagemDe(excecao)}`;
    if (nivel === 'error') {
      this.logger.error(
        resumo,
        excecao instanceof Error ? excecao.stack : undefined,
      );
      if (status === 500) metricas.errosNaoTratados.inc({ tipo: 'http_500' });
    } else {
      this.logger.warn(resumo);
    }

    if (response.headersSent) return;
    response.status(status).json(corpo);
  }

  private traduzir(excecao: unknown): RespostaDeErro {
    if (excecao instanceof HttpException) {
      const status = excecao.getStatus();
      const resposta = excecao.getResponse();
      const corpo =
        typeof resposta === 'string'
          ? { statusCode: status, message: resposta }
          : Array.isArray(resposta)
            ? { statusCode: status, message: resposta as unknown }
            : { ...(resposta as Record<string, unknown>) };
      return { status, corpo, nivel: status >= 500 ? 'error' : 'warn' };
    }

    if (excecao instanceof DomainError) {
      return {
        status: excecao.status,
        corpo: {
          statusCode: excecao.status,
          message: excecao.message,
          code: excecao.code,
          ...(excecao.detalhes ?? {}),
        },
        nivel: 'warn',
      };
    }

    if (excecao instanceof IntegrationError) {
      const status = excecao.statusHttp;
      return {
        status,
        corpo: {
          statusCode: status,
          message: excecao.message,
          code: excecao.code,
        },
        nivel: 'error',
      };
    }

    if (excecao instanceof InfraError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        corpo: {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: excecao.message,
          code: excecao.code,
        },
        nivel: 'error',
      };
    }

    if (ehBancoIndisponivel(excecao)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        corpo: {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: MSG_INDISPONIVEL,
          code: 'INFRA_BANCO_INDISPONIVEL',
        },
        nivel: 'error',
      };
    }

    // Corpo grande demais / JSON inválido: erros do body-parser trazem
    // `status` 4xx e não são HttpException.
    const statusDoParser = statusDeErroDoParser(excecao);
    if (statusDoParser) {
      return {
        status: statusDoParser,
        corpo: {
          statusCode: statusDoParser,
          message:
            statusDoParser === 413
              ? 'Corpo da requisição excede o tamanho permitido'
              : 'Corpo da requisição inválido',
        },
        nivel: 'warn',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      corpo: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
      nivel: 'error',
    };
  }
}

function ehBancoIndisponivel(excecao: unknown): boolean {
  if (excecao instanceof Prisma.PrismaClientInitializationError) return true;
  if (excecao instanceof Prisma.PrismaClientRustPanicError) return true;
  if (excecao instanceof Prisma.PrismaClientKnownRequestError) {
    return PRISMA_INDISPONIVEL.has(excecao.code);
  }
  return false;
}

function statusDeErroDoParser(excecao: unknown): number | null {
  const erro = excecao as { status?: unknown; type?: unknown } | null;
  if (!erro || typeof erro.type !== 'string') return null;
  const status = Number(erro.status);
  return Number.isInteger(status) && status >= 400 && status < 500
    ? status
    : null;
}

function mensagemDe(excecao: unknown): string {
  if (excecao instanceof ErroDeAplicacao) {
    const detalhe =
      excecao instanceof IntegrationError
        ? ` vendor=${excecao.vendor} tipo=${excecao.tipo}${excecao.base ? ` base=${excecao.base}` : ''}${excecao.statusVendor ? ` statusVendor=${excecao.statusVendor}` : ''}`
        : '';
    return `${excecao.code}: ${excecao.message}${detalhe}`;
  }
  if (excecao instanceof Error) return `${excecao.name}: ${excecao.message}`;
  return String(excecao);
}
