import { Injectable, Logger } from '@nestjs/common';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  ConteudoDoDisparo,
  Destinatario,
  ENTREGAS_POR_LOTE,
  EstadoDoDisparo,
  JANELA_DE_REPETICAO_MS,
  JOB_PUSH_LOTE,
  LoteJobData,
  chaveDeConteudo,
  entregaAberta,
  jobIdDoLote,
  mesmosDestinatarios,
  paginasComPendencia,
} from 'src/notifications/domain/push-disparo';
import {
  DisparoPush,
  NovoDisparo,
  PushDisparoRepository,
} from 'src/notifications/repositories/push-disparo.repository';
import { PushLoteService } from 'src/notifications/services/push-lote.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { PUSH_MASSA_QUEUE } from 'src/queue/queue.module';

/** Página da seleção de destinatários do marketing. */
const USUARIOS_POR_PAGINA = 5_000;
/**
 * Entregas lidas por vez ao montar as páginas dos lotes. Múltiplo do tamanho
 * do lote, para as páginas caírem sempre nas mesmas fronteiras.
 */
const ENTREGAS_POR_BLOCO = 50 * ENTREGAS_POR_LOTE;

export interface PaginaDeDestinatarios {
  destinatarios: Destinatario[];
  /** Usuários que a seleção deixou de fora (token com formato inválido). */
  ignorados: number;
}

/** De onde vêm os destinatários. Pode ser percorrida de novo (retomada). */
export type FonteDeDestinatarios = () =>
  | AsyncIterable<PaginaDeDestinatarios>
  | Iterable<PaginaDeDestinatarios>;

export interface DisparoCriado {
  disparoId: number;
  estado: EstadoDoDisparo;
  totalDestinatarios: number;
  ignorados: number;
  /** O pedido era igual a um disparo já existente, que foi devolvido. */
  repetido: boolean;
}

/**
 * Criação do disparo de push em massa. Só grava e enfileira — o envio é dos
 * jobs de lote (`PushLoteService`):
 *
 *   CRIADO (entregas sendo gravadas) → ENVIANDO (lotes na fila) → CONCLUIDO | FALHOU
 *
 * Nenhum lote entra na fila antes de `ENVIANDO`, então um disparo que morre
 * em `CRIADO` não mandou nada. Todos os passos podem ser repetidos: entrega
 * é única por (disparo, usuário) e o job de cada página tem id fixo.
 */
@Injectable()
export class PushDisparoService {
  private readonly logger = new Logger(PushDisparoService.name);

  constructor(
    private readonly repo: PushDisparoRepository,
    private readonly gateway: PushGateway,
    private readonly produtor: ProdutorDeFilas,
    private readonly lotes: PushLoteService,
  ) {}

  /** Marketing: usuários ativos, com opt-in e token de formato válido. */
  fonteDeMarketing(): FonteDeDestinatarios {
    return () => this.paginasDeMarketing();
  }

  /** Lista já resolvida por quem chama (planilha de CPFs). */
  fonteFixa(
    destinatarios: Destinatario[],
    ignorados: number,
  ): FonteDeDestinatarios {
    return () => [{ destinatarios, ignorados }];
  }

  /**
   * Cria o disparo, grava as entregas e enfileira os lotes. Se a criação
   * falha antes de `ENVIANDO`, o disparo e o log do painel ficam como
   * falhos (nada foi enviado) e o erro segue para quem chamou.
   */
  async criar(
    novo: NovoDisparo,
    fonte: FonteDeDestinatarios,
  ): Promise<DisparoCriado> {
    let disparo: DisparoPush;
    try {
      disparo = await this.repo.criarDisparo(novo);
    } catch (erro) {
      if (novo.marketingAuditLogId) {
        await this.repo.falharLog(
          novo.marketingAuditLogId,
          mensagemDe(erro),
          new Date(),
        );
      }
      throw erro;
    }

    try {
      return await this.popularEIniciar(disparo, fonte);
    } catch (erro) {
      // Só tem efeito em `CRIADO`. Se a falha foi ao enfileirar (já em
      // `ENVIANDO`), o disparo segue aberto e a varredura o retoma.
      await this.repo.falharCriacao(disparo.id, mensagemDe(erro), new Date());
      throw erro;
    }
  }

  /**
   * Leva um disparo existente adiante, do ponto em que estiver: termina a
   * criação (`CRIADO`) ou recoloca na fila os lotes que faltam (`ENVIANDO`).
   * Disparo já fechado só é devolvido.
   */
  async retomar(
    disparo: DisparoPush,
    fonte: FonteDeDestinatarios,
  ): Promise<DisparoCriado> {
    if (disparo.estado === 'CRIADO') {
      return {
        ...(await this.popularEIniciar(disparo, fonte)),
        repetido: true,
      };
    }
    if (disparo.estado === 'ENVIANDO') await this.enfileirarLotes(disparo.id);
    return {
      disparoId: disparo.id,
      estado: disparo.estado as EstadoDoDisparo,
      totalDestinatarios: disparo.totalDestinatarios,
      ignorados: 0,
      repetido: true,
    };
  }

  /** Grava as entregas, passa a `ENVIANDO` e enfileira os lotes. */
  async popularEIniciar(
    disparo: Pick<DisparoPush, 'id'>,
    fonte: FonteDeDestinatarios,
  ): Promise<DisparoCriado> {
    let ignorados = 0;
    for await (const pagina of fonte()) {
      await this.repo.criarEntregas(disparo.id, pagina.destinatarios);
      ignorados += pagina.ignorados;
    }

    const total = await this.repo.contarEntregas(disparo.id);
    // `false` = outra execução já tinha iniciado; segue igual, é idempotente.
    await this.repo.iniciarEnvio(disparo.id, { total, ignorados }, new Date());

    if (total === 0) {
      this.logger.warn(
        `[PUSH] disparo #${disparo.id} sem destinatários válidos`,
      );
      await this.lotes.tentarFechar(disparo.id);
      return this.criado(disparo.id, 'CONCLUIDO', total, ignorados);
    }

    const lotes = await this.enfileirarLotes(disparo.id);
    this.logger.log(
      `[PUSH] disparo #${disparo.id}: ${total} destinatário(s) em ${lotes} lote(s) na fila`,
    );
    return this.criado(disparo.id, 'ENVIANDO', total, ignorados);
  }

  /**
   * Enfileira um job por página que ainda tem entrega aberta. `retomada`
   * (só na varredura) muda o id dos jobs, porque os originais podem ainda
   * estar no Redis como concluídos ou falhos. Devolve quantos jobs pediu.
   */
  async enfileirarLotes(disparoId: number, retomada?: number): Promise<number> {
    let lotes = 0;
    let aposId = 0;

    for (;;) {
      const bloco = await this.repo.blocoDeEntregas(
        disparoId,
        aposId,
        ENTREGAS_POR_BLOCO,
      );
      if (bloco.length === 0) break;

      const paginas = paginasComPendencia(
        bloco.map((e) => ({ id: e.id, aberta: entregaAberta(e) })),
      );
      for (const pagina of paginas) {
        await this.produtor.enfileirar<LoteJobData>(
          PUSH_MASSA_QUEUE,
          JOB_PUSH_LOTE,
          { disparoId, ...pagina },
          { jobId: jobIdDoLote(disparoId, pagina.deId, retomada) },
        );
        lotes++;
      }

      aposId = bloco[bloco.length - 1].id;
      if (bloco.length < ENTREGAS_POR_BLOCO) break;
    }
    return lotes;
  }

  /**
   * Disparo igual ao pedido (mesmo tipo, texto, carga e — na planilha —
   * mesma lista) que está em andamento ou acabou de ser concluído. É o que
   * transforma o segundo clique em "o mesmo disparo".
   */
  async buscarRepetido(
    conteudo: ConteudoDoDisparo,
    agora: Date,
  ): Promise<DisparoPush | null> {
    const candidatos = await this.repo.candidatosARepeticao(
      conteudo.tipo,
      conteudo.titulo,
      new Date(agora.getTime() - JANELA_DE_REPETICAO_MS),
    );
    const chave = chaveDeConteudo({ ...conteudo, userIds: undefined });

    for (const candidato of candidatos) {
      const chaveDoCandidato = chaveDeConteudo({
        tipo: conteudo.tipo,
        titulo: candidato.titulo,
        corpo: candidato.corpo,
        dados: candidato.dados,
      });
      if (chaveDoCandidato !== chave) continue;

      if (conteudo.userIds) {
        const existentes = await this.repo.usuariosDoDisparo(candidato.id);
        const igual = mesmosDestinatarios(
          existentes,
          conteudo.userIds,
          candidato.estado === 'CRIADO',
        );
        if (!igual) continue;
      }
      return candidato;
    }
    return null;
  }

  private async *paginasDeMarketing(): AsyncGenerator<PaginaDeDestinatarios> {
    let aposId = 0;
    for (;;) {
      const usuarios = await this.repo.paginaDeUsuariosDeMarketing(
        aposId,
        USUARIOS_POR_PAGINA,
      );
      if (usuarios.length === 0) return;

      const destinatarios: Destinatario[] = [];
      for (const usuario of usuarios) {
        if (this.gateway.tokenValido(usuario.expoPushToken)) {
          destinatarios.push({
            userId: usuario.id,
            expoPushToken: usuario.expoPushToken,
          });
        }
      }
      yield {
        destinatarios,
        ignorados: usuarios.length - destinatarios.length,
      };

      aposId = usuarios[usuarios.length - 1].id;
      if (usuarios.length < USUARIOS_POR_PAGINA) return;
    }
  }

  private criado(
    disparoId: number,
    estado: EstadoDoDisparo,
    totalDestinatarios: number,
    ignorados: number,
  ): DisparoCriado {
    return {
      disparoId,
      estado,
      totalDestinatarios,
      ignorados,
      repetido: false,
    };
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
