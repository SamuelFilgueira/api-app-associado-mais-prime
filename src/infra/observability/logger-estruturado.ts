import { ConsoleLogger, LoggerService } from '@nestjs/common';
import { AppConfig, NivelDeLog, appConfig } from 'src/config/app.config';
import { contextoExecucao } from 'src/infra/observability/contexto-execucao';
import { redigirTexto, redigirValor } from 'src/infra/observability/redacao';

const PESO: Record<NivelDeLog, number> = {
  error: 0,
  warn: 1,
  log: 2,
  debug: 3,
  verbose: 4,
};

type Saida = (linha: string) => void;

/**
 * Logger da aplicação. Substitui o logger padrão do Nest via `app.useLogger`,
 * então os `new Logger(X.name)` espalhados pelo código passam por aqui sem
 * mudar uma linha.
 *
 * - `LOG_FORMAT=json` (padrão em produção): uma linha JSON por evento no
 *   stdout, com campos fixos — `ts`, `level`, `context`, `msg`, `role` e,
 *   quando existem, `requestId`, `base`, `userId`, `rota`, `queue`, `jobId`.
 * - `LOG_FORMAT=text` (padrão fora de produção): a saída colorida do Nest,
 *   com o `requestId` no fim da linha.
 *
 * Toda mensagem e stack passa pela redação de CPF, token e senha.
 */
export class LoggerEstruturado implements LoggerService {
  private readonly console = new ConsoleLogger();
  private readonly config: AppConfig['log'];
  private readonly role: string;

  constructor(
    config: AppConfig = appConfig(),
    private readonly escrever: Saida = (linha) => {
      process.stdout.write(`${linha}\n`);
    },
  ) {
    this.config = config.log;
    this.role = config.role;
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emitir('log', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emitir('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emitir('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emitir('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emitir('error', message, params, true);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emitir('error', message, params);
  }

  private emitir(
    nivel: NivelDeLog,
    message: unknown,
    params: unknown[],
    fatal = false,
  ): void {
    if (PESO[nivel] > PESO[this.config.nivel]) return;

    const { contexto, stack, extras } = separarParametros(nivel, params);
    const redigir = this.config.redigirPii;

    if (this.config.formato === 'text') {
      this.emitirTexto(nivel, message, contexto, stack, extras, redigir);
      return;
    }

    const ctx = contextoExecucao.atual();
    const linha: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: fatal ? 'fatal' : nivel,
      context: contexto,
      msg: resumoDaMensagem(message, redigir),
      role: this.role,
      requestId: ctx?.requestId,
      base: ctx?.base,
      userId: ctx?.userId,
      rota: ctx?.rota,
      queue: ctx?.queue,
      jobId: ctx?.jobId,
      jobName: ctx?.jobName,
    };

    if (message !== null && typeof message === 'object') {
      linha.data = redigir ? redigirValor(message) : message;
    }
    if (message instanceof Error) {
      linha.erro = message.name;
      linha.stack = redigir ? redigirTexto(message.stack ?? '') : message.stack;
    }
    if (stack) linha.stack = redigir ? redigirTexto(stack) : stack;
    if (extras.length > 0) {
      linha.extra = redigir ? redigirValor(extras) : extras;
    }

    this.escrever(serializar(linha));
  }

  private emitirTexto(
    nivel: NivelDeLog,
    message: unknown,
    contexto: string | undefined,
    stack: string | undefined,
    extras: unknown[],
    redigir: boolean,
  ): void {
    const requestId = contextoExecucao.requestId();
    let texto = formatarMensagem(message, redigir);
    if (extras.length > 0) {
      texto += ` ${formatarMensagem(extras, redigir)}`;
    }
    if (requestId) texto += ` (req=${requestId.slice(0, 8)})`;

    if (nivel === 'error') {
      const pilha = stack && redigir ? redigirTexto(stack) : stack;
      this.console.error(texto, pilha, contexto);
      return;
    }
    this.console[nivel](texto, contexto);
  }
}

/**
 * O `Logger` do Nest passa o contexto como último parâmetro; em `error`, o
 * penúltimo é a stack (`logger.error(msg, stack, contexto)`).
 */
function separarParametros(
  nivel: NivelDeLog,
  params: unknown[],
): { contexto?: string; stack?: string; extras: unknown[] } {
  const restantes = [...params];
  let contexto: string | undefined;
  let stack: string | undefined;

  if (restantes.length > 0 && typeof restantes.at(-1) === 'string') {
    contexto = restantes.pop() as string;
  }

  if (nivel === 'error' && restantes.length > 0) {
    const candidato = restantes[0];
    if (typeof candidato === 'string') {
      stack = candidato;
      restantes.shift();
    } else if (candidato instanceof Error) {
      stack = candidato.stack ?? candidato.message;
      restantes.shift();
    } else if (candidato === undefined || candidato === null) {
      restantes.shift();
    }
  }

  return { contexto, stack, extras: restantes };
}

/**
 * Texto do campo `msg` no JSON. Para mensagem em objeto, o conteúdo vai em
 * `data`; aqui fica só o nome do evento, para a linha não carregar o mesmo
 * objeto duas vezes.
 */
function resumoDaMensagem(message: unknown, redigir: boolean): string {
  if (
    message !== null &&
    typeof message === 'object' &&
    !(message instanceof Error)
  ) {
    const objeto = message as Record<string, unknown>;
    const rotulo = objeto.evento ?? objeto.message ?? objeto.msg;
    return typeof rotulo === 'string'
      ? redigir
        ? redigirTexto(rotulo)
        : rotulo
      : 'objeto';
  }
  return formatarMensagem(message, redigir);
}

function formatarMensagem(message: unknown, redigir: boolean): string {
  if (typeof message === 'string') {
    return redigir ? redigirTexto(message) : message;
  }
  if (message instanceof Error) {
    return redigir ? redigirTexto(message.message) : message.message;
  }
  if (message === null || message === undefined) return String(message);
  if (typeof message === 'object') {
    return serializar(redigir ? redigirValor(message) : message);
  }
  return String(message as number | boolean | bigint | symbol);
}

/** `JSON.stringify` que não quebra com BigInt nem referência circular. */
function serializar(valor: unknown): string {
  const vistos = new WeakSet<object>();
  try {
    return JSON.stringify(valor, (_chave, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (item !== null && typeof item === 'object') {
        if (vistos.has(item)) return '[circular]';
        vistos.add(item);
      }
      return item;
    });
  } catch {
    return '"[não serializável]"';
  }
}
