import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/database/prisma.service';

/** Formato aceito no header `Idempotency-Key`. */
const CHAVE_VALIDA = /^[A-Za-z0-9._:-]{8,100}$/;
/** Por quanto tempo a resposta gravada vale para repetições. */
const VALIDADE_PADRAO_HORAS = 24;
/**
 * Depois deste tempo, uma operação ainda `EM_ANDAMENTO` é dada como morta
 * (processo caiu no meio) e a repetição assume a chave.
 */
const ABANDONADA_APOS_MS = 60_000;

export interface OperacaoIdempotente {
  userId: number;
  /** Nome estável da operação: `sorte.loja.comprar`. */
  escopo: string;
  /** Valor do header `Idempotency-Key`; ausente = sem idempotência. */
  chave: string | undefined | null;
  /** Corpo da requisição: a mesma chave não pode vir com outro corpo. */
  corpo: unknown;
  validadeHoras?: number;
}

/**
 * Idempotência de escritas disparadas por toque do usuário.
 *
 * O app manda um `Idempotency-Key` (um UUID por tentativa do usuário, repetido
 * nos reenvios automáticos). A primeira requisição com a chave executa; as
 * repetições recebem a MESMA resposta, sem executar de novo — duplo toque ou
 * retry por timeout deixam de gerar dois pedidos e dois débitos.
 *
 * O header é opcional: sem ele a operação roda como sempre, e as versões
 * antigas do app continuam funcionando.
 *
 * A resposta guardada precisa ser serializável em JSON.
 */
@Injectable()
export class IdempotenciaService {
  private readonly logger = new Logger(IdempotenciaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async executar<T>(
    pedido: OperacaoIdempotente,
    operacao: () => Promise<T>,
  ): Promise<T> {
    const chave = pedido.chave?.trim();
    if (!chave) return operacao();

    if (!CHAVE_VALIDA.test(chave)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCIA_CHAVE_INVALIDA',
        message:
          'Idempotency-Key inválida: use de 8 a 100 caracteres (letras, números, ponto, hífen, sublinhado ou dois-pontos).',
      });
    }

    const corpoHash = hashDoCorpo(pedido.corpo);
    const onde = {
      userId_escopo_chave: {
        userId: pedido.userId,
        escopo: pedido.escopo,
        chave,
      },
    };
    const expiraEm = new Date(
      Date.now() + (pedido.validadeHoras ?? VALIDADE_PADRAO_HORAS) * 3_600_000,
    );

    const reservada = await this.reservar(pedido, chave, corpoHash, expiraEm);
    if (!reservada) {
      const repetida = await this.repeticao<T>(onde, corpoHash, expiraEm);
      if (repetida.tipo === 'resposta') return repetida.valor;
      // `assumida`: a operação anterior morreu no meio; esta segue no lugar.
    }

    try {
      const resposta = await operacao();
      await this.prisma.chaveDeIdempotencia
        .update({
          where: onde,
          data: {
            estado: 'CONCLUIDA',
            statusHttp: 200,
            resposta: (resposta ?? null) as Prisma.InputJsonValue,
          },
        })
        .catch((erro: Error) =>
          // A operação já aconteceu; sem a resposta gravada, a repetição
          // fica em "em andamento" até a chave ser dada como abandonada.
          this.logger.error(
            `Falha ao gravar a resposta idempotente (${pedido.escopo}): ${erro.message}`,
          ),
        );
      return resposta;
    } catch (erro) {
      // Falhou: libera a chave para o usuário poder tentar de novo.
      await this.prisma.chaveDeIdempotencia
        .delete({ where: onde })
        .catch(() => undefined);
      throw erro;
    }
  }

  private async reservar(
    pedido: OperacaoIdempotente,
    chave: string,
    corpoHash: string,
    expiraEm: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.chaveDeIdempotencia.create({
        data: {
          userId: pedido.userId,
          escopo: pedido.escopo,
          chave,
          corpoHash,
          expiraEm,
        },
      });
      return true;
    } catch (erro) {
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002'
      ) {
        return false;
      }
      throw erro;
    }
  }

  private async repeticao<T>(
    onde: Prisma.ChaveDeIdempotenciaWhereUniqueInput,
    corpoHash: string,
    expiraEm: Date,
  ): Promise<{ tipo: 'resposta'; valor: T } | { tipo: 'assumida' }> {
    const existente = await this.prisma.chaveDeIdempotencia.findUnique({
      where: onde,
    });

    // Apagada entre a tentativa de criar e a leitura (a primeira falhou):
    // quem repete precisa mandar de novo.
    if (!existente) throw this.emAndamento();

    // Chave vencida que o expurgo ainda não levou: vale como chave nova.
    if (existente.expiraEm.getTime() <= Date.now()) {
      return this.assumir(onde, existente.criadoEm, corpoHash, expiraEm);
    }

    if (existente.corpoHash !== corpoHash) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'IDEMPOTENCIA_CHAVE_REUTILIZADA',
        message:
          'Esta Idempotency-Key já foi usada em outra requisição. Gere uma chave nova.',
      });
    }

    if (existente.estado === 'CONCLUIDA') {
      return { tipo: 'resposta', valor: existente.resposta as T };
    }

    if (Date.now() - existente.criadoEm.getTime() < ABANDONADA_APOS_MS) {
      throw this.emAndamento();
    }
    return this.assumir(onde, existente.criadoEm, corpoHash, expiraEm);
  }

  /**
   * Assume uma chave abandonada. O `updateMany` condicionado ao `criadoEm`
   * lido garante que só UMA repetição assume.
   */
  private async assumir(
    onde: Prisma.ChaveDeIdempotenciaWhereUniqueInput,
    criadoEmLido: Date,
    corpoHash: string,
    expiraEm: Date,
  ): Promise<{ tipo: 'assumida' }> {
    const { count } = await this.prisma.chaveDeIdempotencia.updateMany({
      where: { ...onde.userId_escopo_chave, criadoEm: criadoEmLido },
      data: {
        criadoEm: new Date(),
        estado: 'EM_ANDAMENTO',
        corpoHash,
        expiraEm,
        resposta: Prisma.DbNull,
        statusHttp: null,
      },
    });
    if (count !== 1) throw this.emAndamento();
    return { tipo: 'assumida' };
  }

  private emAndamento(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'OPERACAO_EM_ANDAMENTO',
      message:
        'Esta operação já está sendo processada. Aguarde alguns segundos e tente novamente.',
    });
  }
}

/** SHA-256 do corpo com as chaves ordenadas (a ordem dos campos não importa). */
export function hashDoCorpo(corpo: unknown): string {
  return createHash('sha256').update(serializar(corpo)).digest('hex');
}

function serializar(valor: unknown): string {
  if (valor === null || valor === undefined) return 'null';
  if (Array.isArray(valor)) return `[${valor.map(serializar).join(',')}]`;
  if (typeof valor === 'object') {
    const objeto = valor as Record<string, unknown>;
    return `{${Object.keys(objeto)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${serializar(objeto[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}
