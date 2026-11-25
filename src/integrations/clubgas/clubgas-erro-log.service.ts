import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { baseTag } from 'src/shared/log.util';
import {
  CLUBGAS_FALHAS_DE_INFRA,
  ClubgasErro,
  clubgasErroParaHttp,
} from './clubgas.erro';

/** De onde partiu a chamada: o associado no app ou o job pós-abastecimento. */
export type ClubgasErroOrigem = 'APP' | 'JOB_ECONOMIA';

/** Quem estava usando o Clubgas e com quais dados quando a falha ocorreu. */
export interface ClubgasErroContexto {
  userId: number;
  baseOrigin?: string | null;
  /** Padrão: `APP`. */
  origem?: ClubgasErroOrigem;
  chassi?: string | null;
  placa?: string | null;
  /** CPF/CNPJ enviado ao Clubgas. */
  documento?: string | null;
}

const LIMITE_MENSAGEM = 500;
const LIMITE_RESPOSTA = 4_000;

function respostaParaLog(resposta: unknown): Prisma.InputJsonValue | undefined {
  if (resposta === null || resposta === undefined) return undefined;
  let texto: string | undefined;
  try {
    texto = JSON.stringify(resposta);
  } catch {
    texto = undefined;
  }
  if (texto === undefined) return undefined;
  if (texto.length > LIMITE_RESPOSTA) {
    return { truncado: true, inicio: texto.slice(0, LIMITE_RESPOSTA) };
  }
  return JSON.parse(texto) as Prisma.InputJsonValue;
}

/**
 * Registra as falhas do Clubgas em `ClubgasErroLog` (qual usuário, o que foi
 * enviado e o que o Clubgas respondeu) e as converte na resposta HTTP do app.
 */
@Injectable()
export class ClubgasErroLogService {
  private readonly logger = new Logger(ClubgasErroLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Uso: `catch (falha) { throw await this.clubgasErros.tratar(falha, contexto); }`.
   * Registra o `ClubgasErro` e devolve a exceção HTTP equivalente; qualquer
   * outro erro volta como veio.
   */
  async tratar(falha: unknown, contexto: ClubgasErroContexto): Promise<Error> {
    if (!(falha instanceof ClubgasErro)) {
      return falha instanceof Error ? falha : new Error(String(falha));
    }
    await this.registrar(falha, contexto);
    return clubgasErroParaHttp(falha);
  }

  /** Grava a falha. Nunca lança: o log não pode derrubar o fluxo do associado. */
  async registrar(
    erro: ClubgasErro,
    contexto: ClubgasErroContexto,
  ): Promise<void> {
    // O documento (CPF/CNPJ) vai só para o banco, nunca para o log de texto.
    const descricao =
      `${baseTag(contexto.baseOrigin ?? undefined)} [clubgas] ${erro.operacao} ` +
      `${erro.categoria} http=${erro.httpStatus ?? '-'} userId=${contexto.userId} ` +
      `placa=${contexto.placa ?? '-'} — ${erro.message}`;
    if (CLUBGAS_FALHAS_DE_INFRA.has(erro.categoria)) {
      this.logger.error(descricao);
    } else {
      this.logger.warn(descricao);
    }

    try {
      await this.prisma.clubgasErroLog.create({
        data: {
          userId: contexto.userId,
          userDocumento: contexto.documento ?? null,
          baseOrigin: contexto.baseOrigin ?? null,
          operacao: erro.operacao,
          origem: contexto.origem ?? 'APP',
          chassi: contexto.chassi ?? null,
          placa: contexto.placa ?? null,
          categoria: erro.categoria,
          httpStatus: erro.httpStatus,
          mensagem: erro.message.slice(0, LIMITE_MENSAGEM),
          resposta: respostaParaLog(erro.resposta),
          duracaoMs: erro.duracaoMs,
        },
      });
    } catch (falha) {
      this.logger.error(
        `[clubgas] Falha ao gravar ClubgasErroLog (userId=${contexto.userId}): ` +
          (falha instanceof Error ? falha.message : String(falha)),
      );
    }
  }
}
