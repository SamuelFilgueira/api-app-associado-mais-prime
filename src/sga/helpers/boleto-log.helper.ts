import { Logger } from '@nestjs/common';
import { debugLog } from 'src/shared/debug-log.util';
import { baseTag } from 'src/shared/log.util';

/** Linha de log do boleto de reativação: base, revistoria e origem sempre. */
export function logDoBoleto(
  logger: Logger,
  classe: string,
  nivel: 'log' | 'warn' | 'error',
  alvo: {
    reinspectionId: number;
    baseOrigin?: string | null;
    origem: string;
    debugId?: string;
  },
  mensagem: string,
  meta: Record<string, unknown> = {},
): void {
  logger[nivel](
    `${baseTag(alvo.baseOrigin ?? undefined)} ${debugLog(
      classe,
      mensagem,
      alvo.debugId,
      { reinspectionId: alvo.reinspectionId, origem: alvo.origem, ...meta },
    )}`,
  );
}
