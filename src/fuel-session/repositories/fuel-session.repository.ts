import { Injectable } from '@nestjs/common';
import { FuelSession, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { chaveDePendencia } from 'src/fuel-session/domain/verificacao-de-economia';

function ehViolacaoDeUnico(erro: unknown): boolean {
  return (
    erro instanceof Prisma.PrismaClientKnownRequestError &&
    erro.code === 'P2002'
  );
}

/**
 * Escritas da `FuelSession`.
 *
 * Duas regras valem para tudo aqui:
 *  - uma sessão `PENDING` por usuário: enquanto pendente, `pendenteChave`
 *    guarda o id do usuário, e o índice único da coluna recusa a segunda;
 *  - toda saída de `PENDING` é um `UPDATE ... WHERE status = 'PENDING'` que
 *    anula a chave e devolve se ESTA chamada fez a transição. Quem perde a
 *    corrida recebe `false` e não repete o efeito (push, total do usuário).
 */
@Injectable()
export class FuelSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  buscarPorId(id: string): Promise<FuelSession | null> {
    return this.prisma.fuelSession.findUnique({ where: { id } });
  }

  /** Sessão `PENDING` mais recente do usuário, ou `null`. */
  buscarPendenteDoUsuario(userId: number): Promise<FuelSession | null> {
    return this.prisma.fuelSession.findFirst({
      where: { userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cria a sessão `PENDING` do usuário ou, se já existe uma (o segundo toque
   * no cartão bate no índice único), devolve a que existe.
   */
  async criarPendente(
    userId: number,
    valorAntes: number,
  ): Promise<{ sessao: FuelSession; criada: boolean }> {
    const pendenteChave = chaveDePendencia(userId);
    let recusa: unknown;

    // Mais de uma volta porque a vaga pode abrir entre o INSERT recusado e a
    // leitura: a pendente foi encerrada nesse meio-tempo, ou a chave estava
    // presa e acabou de ser solta (ver abaixo).
    for (let volta = 0; volta < 3; volta++) {
      try {
        const sessao = await this.prisma.fuelSession.create({
          data: { userId, valorAntes, status: 'PENDING', pendenteChave },
        });
        return { sessao, criada: true };
      } catch (erro) {
        if (!ehViolacaoDeUnico(erro)) throw erro;
        recusa = erro;
      }

      const dona = await this.prisma.fuelSession.findUnique({
        where: { pendenteChave },
      });
      if (dona?.status === 'PENDING') return { sessao: dona, criada: false };

      if (dona) {
        // Chave presa numa sessão que já saiu de `PENDING`: só acontece se
        // ela foi encerrada por uma versão do worker anterior a esta coluna
        // (janela de deploy ou rollback), que não anula a chave. Sem soltar,
        // o usuário nunca mais teria verificação de economia.
        await this.prisma.fuelSession.updateMany({
          where: {
            id: dona.id,
            status: { not: 'PENDING' },
            pendenteChave,
          },
          data: { pendenteChave: null },
        });
      }
    }

    throw recusa;
  }

  /**
   * `PENDING` → `COMPLETED`, com o total do usuário atualizado na mesma
   * transação. `false`: a sessão já não estava pendente (outra execução a
   * concluiu ou expirou) e nada foi gravado.
   */
  concluir(dados: {
    sessionId: string;
    userId: number;
    valorDepois: number;
    diferenca: number;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.fuelSession.updateMany({
        where: { id: dados.sessionId, status: 'PENDING' },
        data: {
          valorDepois: dados.valorDepois,
          diferenca: dados.diferenca,
          status: 'COMPLETED',
          pendenteChave: null,
        },
      });
      if (count === 0) return false;

      await tx.user.update({
        where: { id: dados.userId },
        data: { totalEconomizado: dados.valorDepois },
      });
      return true;
    });
  }

  /** `PENDING` → `EXPIRED`. `false`: a sessão já não estava pendente. */
  async expirar(sessionId: string): Promise<boolean> {
    const { count } = await this.prisma.fuelSession.updateMany({
      where: { id: sessionId, status: 'PENDING' },
      data: { status: 'EXPIRED', pendenteChave: null },
    });
    return count > 0;
  }

  /**
   * Expira as sessões `PENDING` do usuário criadas antes de `corte` (órfãs:
   * o job que as encerraria não rodou). Devolve quantas expirou.
   */
  async expirarPendentesVencidas(userId: number, corte: Date): Promise<number> {
    const { count } = await this.prisma.fuelSession.updateMany({
      where: { userId, status: 'PENDING', createdAt: { lt: corte } },
      data: { status: 'EXPIRED', pendenteChave: null },
    });
    return count;
  }
}
