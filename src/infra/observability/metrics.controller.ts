import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { isIP } from 'net';
import { appConfig } from 'src/config/app.config';
import { segredosIguais } from 'src/infra/auth/comparacao-segura';
import { registroDeMetricas } from 'src/infra/observability/metricas';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';

/**
 * `GET /metrics` (fora do prefixo `/api`), no formato do Prometheus.
 *
 * Acesso: com `METRICS_TOKEN` definido, exige `Authorization: Bearer <token>`;
 * sem ele, responde só a endereço de loopback ou de rede privada (o coletor
 * roda na mesma máquina ou na rede do Docker). O proxy bloqueia a rota para
 * fora de qualquer forma.
 */
@ApiExcludeController()
@Controller('metrics')
@LimiteDeTaxa('nenhuma')
export class MetricsController {
  @Get()
  @Header('Cache-Control', 'no-store')
  async metricas(@Req() req: Request): Promise<string> {
    const { habilitado, token } = appConfig().metrics;
    if (!habilitado) throw new NotFoundException();

    if (token) {
      const recebido = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
      if (!segredosIguais(recebido?.[1], token)) throw new ForbiddenException();
    } else if (!ehEnderecoInterno(req.ip ?? req.socket?.remoteAddress)) {
      throw new ForbiddenException();
    }

    (
      req.res as { setHeader(n: string, v: string): void } | undefined
    )?.setHeader('Content-Type', registroDeMetricas.contentType);
    return registroDeMetricas.metrics();
  }
}

/** Loopback ou faixa privada (RFC 1918 / ULA). */
export function ehEnderecoInterno(endereco: string | undefined): boolean {
  if (!endereco) return false;
  const ip = endereco.replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  if (isIP(ip) === 6) return /^f[cd]/i.test(ip);
  if (isIP(ip) !== 4) return false;

  const [a, b] = ip.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
