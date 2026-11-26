import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  Observable,
  catchError,
  finalize,
  from,
  mergeMap,
  throwError,
} from 'rxjs';
import { appConfig } from 'src/config/app.config';
import { metricas } from 'src/infra/observability/metricas';
import { ehEnderecoInterno } from 'src/infra/observability/metrics.controller';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';
import {
  LIMITE_DE_TAXA_KEY,
  MetadadoDoLimite,
} from 'src/infra/rate-limit/limite-de-taxa.decorator';
import {
  FonteDeValor,
  JanelaDeLimite,
  NomeDaPolitica,
  POLITICAS_DE_LIMITE,
  POLITICA_PADRAO,
  PoliticaDeLimite,
} from 'src/infra/rate-limit/rate-limit.politicas';

/** Respostas do handler que contam como "falha" nas políticas `falhas`. */
const STATUS_DE_FALHA = new Set([400, 401, 403, 404, 422]);

/** Tempo máximo que a vaga de uma requisição simultânea fica presa. */
const TTL_SIMULTANEO_SEG = 300;

type RequisicaoComUsuario = Request & {
  user?: { userId?: number | string; baseOrigin?: string };
};

interface ChaveResolvida {
  janela: JanelaDeLimite;
  chave: string;
}

/**
 * Limite de requisições por política, compartilhado entre as réplicas.
 *
 * É um interceptor (e não um guard global) porque precisa do usuário
 * autenticado: guards globais rodam antes do `JwtAuthGuard` da rota, e a
 * chave das rotas autenticadas é o `userId`, nunca só o IP. O limite grosso
 * por IP, antes de qualquer processamento, fica no Nginx.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger('RateLimit');

  constructor(
    private readonly reflector: Reflector,
    private readonly limitador: LimitadorService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const config = appConfig().rateLimit;
    if (context.getType() !== 'http' || !config.habilitado) {
      return next.handle();
    }

    const meta = this.reflector.getAllAndOverride<MetadadoDoLimite | undefined>(
      LIMITE_DE_TAXA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (meta?.politica === 'nenhuma') return next.handle();

    const req = context.switchToHttp().getRequest<RequisicaoComUsuario>();
    const nome: NomeDaPolitica | null =
      meta?.politica ?? (req.user?.userId != null ? POLITICA_PADRAO : null);
    if (!nome) return next.handle();

    const politica: PoliticaDeLimite = POLITICAS_DE_LIMITE[nome];
    const aplicar = politica.modo === 'aplicar' || config.aplicarTudo;
    const identificador = lerValor(
      req,
      meta?.identificador ?? politica.identificador,
    );
    const chaves = this.resolverChaves(nome, politica, req, identificador);
    const res = context.switchToHttp().getResponse<Response>();

    return from(this.verificar(nome, politica, chaves, req)).pipe(
      mergeMap(({ bloqueadoPorMs, liberarVaga }) => {
        if (bloqueadoPorMs !== null) {
          metricas.rateLimit.inc({
            politica: nome,
            resultado: aplicar ? 'bloqueado' : 'observado',
          });
          if (aplicar) {
            void liberarVaga();
            const segundos = Math.max(1, Math.ceil(bloqueadoPorMs / 1000));
            res.setHeader('Retry-After', String(segundos));
            return throwError(
              () =>
                new HttpException(
                  {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message:
                      'Muitas requisições. Aguarde um instante e tente novamente.',
                    code: 'LIMITE_DE_REQUISICOES',
                    retryAfter: segundos,
                  },
                  HttpStatus.TOO_MANY_REQUESTS,
                ),
            );
          }
        } else {
          metricas.rateLimit.inc({ politica: nome, resultado: 'permitido' });
        }

        return next.handle().pipe(
          catchError((erro: unknown) => {
            if (politica.contar === 'falhas' && ehFalhaDoChamador(erro)) {
              void this.contarFalha(politica, chaves);
            }
            return throwError(() => erro);
          }),
          finalize(() => void liberarVaga()),
        );
      }),
    );
  }

  private resolverChaves(
    nome: NomeDaPolitica,
    politica: PoliticaDeLimite,
    req: RequisicaoComUsuario,
    identificador: string | null,
  ): ChaveResolvida[] {
    const usuario = req.user?.userId != null ? String(req.user.userId) : null;
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'sem-ip';
    const base = req.user?.baseOrigin ?? '-';
    const chaves: ChaveResolvida[] = [];

    politica.janelas.forEach((janela, indice) => {
      let alvo: string | null;
      switch (janela.chave) {
        case 'ip':
          // IP interno significa que o endereço real do cliente não chegou
          // (proxy sem `X-Forwarded-For` ou `trust proxy` desligado). Contar
          // por ele colocaria todos os clientes na mesma janela.
          alvo = ehEnderecoInterno(ip) ? null : `ip:${ip}`;
          break;
        case 'usuario':
          alvo = usuario ? `u:${usuario}` : `ip:${ip}`;
          break;
        case 'identificador':
          // Sem identificador (corpo malformado) a validação do DTO recusa a
          // requisição; aqui só não há o que contar por conta.
          alvo = identificador ? `id:${identificador}` : null;
          break;
        case 'usuario_identificador':
          alvo = `${usuario ? `u:${usuario}` : `ip:${ip}`}:${identificador ?? '-'}`;
          break;
      }
      if (alvo) {
        chaves.push({ janela, chave: `rl:${base}:${nome}:${indice}:${alvo}` });
      }
    });
    return chaves;
  }

  /**
   * Devolve por quanto tempo a requisição está bloqueada (`null` = livre) e
   * a função que devolve a vaga de simultaneidade.
   */
  private async verificar(
    nome: NomeDaPolitica,
    politica: PoliticaDeLimite,
    chaves: ChaveResolvida[],
    req: RequisicaoComUsuario,
  ): Promise<{
    bloqueadoPorMs: number | null;
    liberarVaga: () => Promise<void>;
  }> {
    const semVaga = async (): Promise<void> => {};
    const contar = politica.contar === 'todas';
    let bloqueadoPorMs: number | null = null;

    for (const { janela, chave } of chaves) {
      const resultado = await this.consumir(
        politica,
        nome,
        chave,
        janela,
        contar,
      );
      if (!resultado) continue;
      // `todas` já contou esta requisição; `falhas` só consultou.
      const estourou = contar
        ? resultado.total > janela.limite
        : resultado.total >= janela.limite;
      if (estourou) {
        bloqueadoPorMs = Math.max(bloqueadoPorMs ?? 0, resultado.restanteMs);
      }
    }

    if (bloqueadoPorMs !== null || !politica.simultaneos) {
      return { bloqueadoPorMs, liberarVaga: semVaga };
    }

    const usuario = req.user?.userId;
    if (usuario == null) return { bloqueadoPorMs, liberarVaga: semVaga };

    const chaveVaga = `rl:sim:${nome}:${usuario}`;
    try {
      const emCurso = await this.limitador.ocuparVaga(
        chaveVaga,
        TTL_SIMULTANEO_SEG,
      );
      const liberarVaga = () => this.limitador.liberarVaga(chaveVaga);
      if (emCurso > politica.simultaneos) {
        return { bloqueadoPorMs: 5_000, liberarVaga };
      }
      return { bloqueadoPorMs: null, liberarVaga };
    } catch (erro) {
      // Sem Redis não há como contar simultâneos entre réplicas; o teto
      // global de PDFs é o semáforo do processo que renderiza.
      this.limitador.avisarRedisFora(erro);
      return { bloqueadoPorMs: null, liberarVaga: semVaga };
    }
  }

  private async consumir(
    politica: PoliticaDeLimite,
    nome: NomeDaPolitica,
    chave: string,
    janela: JanelaDeLimite,
    contar: boolean,
  ) {
    try {
      return await this.limitador.consumir(chave, janela.janelaSeg, contar);
    } catch (erro) {
      this.limitador.avisarRedisFora(erro);
      metricas.rateLimit.inc({ politica: nome, resultado: 'erro_redis' });
      return politica.redisFora === 'memoria'
        ? this.limitador.consumirLocal(chave, janela.janelaSeg, contar)
        : null;
    }
  }

  private async contarFalha(
    politica: PoliticaDeLimite,
    chaves: ChaveResolvida[],
  ): Promise<void> {
    for (const { janela, chave } of chaves) {
      try {
        await this.limitador.consumir(chave, janela.janelaSeg, true);
      } catch (erro) {
        this.limitador.avisarRedisFora(erro);
        if (politica.redisFora === 'memoria') {
          this.limitador.consumirLocal(chave, janela.janelaSeg, true);
        }
      }
    }
  }
}

function ehFalhaDoChamador(erro: unknown): boolean {
  return erro instanceof HttpException && STATUS_DE_FALHA.has(erro.getStatus());
}

function lerValor(
  req: RequisicaoComUsuario,
  fonte: FonteDeValor | undefined,
): string | null {
  if (!fonte) return null;
  const bruto: unknown = fonte.corpo
    ? (req.body as Record<string, unknown> | undefined)?.[fonte.corpo]
    : fonte.parametro
      ? req.params?.[fonte.parametro]
      : fonte.query
        ? req.query?.[fonte.query]
        : undefined;

  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null;
  const texto = String(bruto).trim();
  const valor = fonte.digitos
    ? texto.replace(/\D/g, '')
    : texto.toLowerCase().replace(/[^a-z0-9@._-]/g, '');
  // Teto de tamanho: o valor vira parte de uma chave do Redis.
  return valor ? valor.slice(0, 80) : null;
}
