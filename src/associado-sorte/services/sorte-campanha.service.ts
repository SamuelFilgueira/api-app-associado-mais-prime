import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SorteCampanha } from '@prisma/client';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';
import {
  AtualizarCampanhaDto,
  AtualizarMomentoDto,
  CriarCampanhaDto,
  EncerrarCampanhaDto,
  ImportarCronogramaDto,
  ListarCampanhasQuery,
  ListarMomentosQuery,
  MomentoDto,
  PublicarCampanhaDto,
} from 'src/associado-sorte/dto/campanha.dto';
import {
  SorteAutor,
  SorteCampanhaEstado,
  SORTE_MOMENTO_STATUS_LABELS,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  campoCsv,
  dataHoraBrasilia,
  hashCronograma,
  OpcoesCronograma,
  lerCronogramaCsv,
  periodoDasLinhas,
  revalidarCronograma,
} from 'src/associado-sorte/helpers/sorte-cronograma.helper';
import {
  CronogramaXlsxLido,
  lerCronogramaXlsx,
} from 'src/associado-sorte/helpers/sorte-cronograma-xlsx.helper';
import { erro409, erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import {
  mascararCpf,
  metaPaginacao,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  CampanhaAdminView,
  statusDoMomento,
  toCampanhaAdmin,
  toMomentoAdmin,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCampanhasRepository } from 'src/associado-sorte/repositories/sorte-campanhas.repository';
import {
  CampanhaTravada,
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';
import { baseTag } from 'src/shared/log.util';

const AUTOR_SISTEMA = 'Sistema (fim do período)';

/**
 * Campanha e cronograma de momentos premiados (seção 2.4). Publicar grava o
 * SHA-256 do cronograma e TRAVA a campanha: depois disso, criar, editar ou
 * apagar momento e mudar início/fim respondem 409 `CAMPANHA_TRAVADA`. Toda
 * escrita trava a linha da campanha e confere o estado na transação.
 */
@Injectable()
export class SorteCampanhaService {
  private readonly logger = new Logger(SorteCampanhaService.name);

  constructor(
    private readonly repository: SorteCampanhasRepository,
    private readonly uow: SorteUnidadeTrabalho,
  ) {}

  // ---------------------------------------------------------------- leitura

  async listar(query: ListarCampanhasQuery) {
    const where: Prisma.SorteCampanhaWhereInput = {
      ...(query.baseOrigin ? { baseOrigin: query.baseOrigin } : {}),
      ...(query.estado ? { estado: query.estado } : {}),
    };
    const { data, total } = await this.repository.listar({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const agora = new Date();
    const contagens = await this.repository.contarMomentos(
      data.map((c) => c.id),
      agora,
    );
    return {
      serverNow: agora,
      data: data.map((c) => toCampanhaAdmin(c, contagens.get(c.id))),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  async detalhar(id: number): Promise<CampanhaAdminView & { serverNow: Date }> {
    const campanha = await this.exigir(id);
    const agora = new Date();
    const contagens = await this.repository.contarMomentos([id], agora);
    return {
      serverNow: agora,
      ...toCampanhaAdmin(campanha, contagens.get(id)),
    };
  }

  /** Campanha publicada da base (raspadinha e resumo do app). */
  publicadaDaBase(baseOrigin: string): Promise<SorteCampanha | null> {
    return this.repository.publicadaDaBase(baseOrigin);
  }

  async listarMomentos(id: number, query: ListarMomentosQuery) {
    await this.exigir(id);
    const agora = new Date();
    const { data, total } = await this.repository.listarMomentos({
      campanhaId: id,
      status: query.status,
      agora,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const horas = await this.repository.horaDasRaspadas(
      data.map((m) => m.raspadaId).filter((r): r is number => r !== null),
    );
    return {
      serverNow: agora,
      data: data.map((m) =>
        toMomentoAdmin(
          m,
          agora,
          m.raspadaId ? (horas.get(m.raspadaId) ?? null) : null,
        ),
      ),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  // ----------------------------------------------------------------- escrita

  async criar(dto: CriarCampanhaDto, autor: SorteAutor) {
    const { inicio, fim } = this.periodo(dto.inicio, dto.fim);
    const campanha = await this.repository.criar({
      baseOrigin: dto.baseOrigin,
      nome: dto.nome.trim(),
      inicio,
      fim,
    });
    this.logger.log(
      `${baseTag(dto.baseOrigin)} campanha #${campanha.id} "${campanha.nome}" criada em rascunho por ${nomeDoAutor(autor)}`,
    );
    return this.detalhar(campanha.id);
  }

  async atualizar(id: number, dto: AtualizarCampanhaDto) {
    await this.uow.executar(async (tx) => {
      const campanha = await this.travar(tx, id);
      const mudaRegra =
        dto.inicio !== undefined ||
        dto.fim !== undefined ||
        (dto.baseOrigin !== undefined &&
          dto.baseOrigin !== campanha.baseOrigin);
      if (mudaRegra) this.exigirRascunho(campanha);
      if (campanha.estado === SorteCampanhaEstado.ENCERRADA && dto.nome) {
        throw erro409('CAMPANHA_ENCERRADA', 'Esta campanha já foi encerrada');
      }

      const dados: Prisma.SorteCampanhaUncheckedUpdateInput = {};
      if (dto.nome !== undefined) dados.nome = dto.nome.trim();
      if (dto.baseOrigin !== undefined) dados.baseOrigin = dto.baseOrigin;
      if (dto.inicio !== undefined || dto.fim !== undefined) {
        const { inicio, fim } = this.periodo(
          dto.inicio ?? campanha.inicio.toISOString(),
          dto.fim ?? campanha.fim.toISOString(),
        );
        const fora = (await tx.listarMomentos(id)).filter(
          (m) =>
            m.liberaEm.getTime() < inicio.getTime() ||
            m.liberaEm.getTime() > fim.getTime(),
        );
        if (fora.length > 0) {
          throw erro422(
            'MOMENTOS_FORA_DO_PERIODO',
            `${fora.length} momento(s) ficariam fora do novo período. Ajuste o cronograma antes.`,
          );
        }
        dados.inicio = inicio;
        dados.fim = fim;
      }
      if (Object.keys(dados).length > 0) await tx.atualizarCampanha(id, dados);
    });
    return this.detalhar(id);
  }

  async excluir(id: number): Promise<void> {
    await this.uow.executar(async (tx) => {
      this.exigirRascunho(await this.travar(tx, id));
    });
    await this.repository.excluirRascunho(id);
  }

  /** Lê e valida o CSV sem gravar nada (erros por linha). */
  async preVisualizar(id: number, dto: ImportarCronogramaDto) {
    const campanha = await this.exigir(id);
    const substituir = dto.substituir ?? true;
    const existentes = substituir
      ? []
      : (
          await this.repository.listarMomentos({
            campanhaId: id,
            agora: new Date(),
            skip: 0,
            take: associadoSorteConfig().cronogramaMaxLinhas,
          })
        ).data;
    const lido = await this.lerArquivo(dto, {
      periodo: { inicio: campanha.inicio, fim: campanha.fim },
      existentes,
      maxLinhas: associadoSorteConfig().cronogramaMaxLinhas,
    });
    return {
      formato: dto.xlsxBase64 ? 'xlsx' : 'csv',
      aba: lido.aba,
      titulo: lido.titulo,
      resumo: lido.resumo,
      avisos: lido.avisos,
      periodoDoArquivo: periodoDasLinhas(lido.linhas),
      campanhaId: id,
      travada: campanha.estado !== SorteCampanhaEstado.RASCUNHO,
      substituir,
      totalLinhas: lido.linhas.length + lido.erros.length,
      validas: lido.linhas.length,
      totalCreditos: lido.linhas.reduce((s, l) => s + l.creditos, 0),
      linhas: lido.linhas.map((l) => ({
        linha: l.linha,
        liberaEm: l.liberaEm,
        creditos: l.creditos,
        descricao: l.descricao,
      })),
      erros: lido.erros,
    };
  }

  /** Grava o cronograma do CSV (tudo ou nada: com erro, nada é gravado). */
  async importar(id: number, dto: ImportarCronogramaDto, autor: SorteAutor) {
    const substituir = dto.substituir ?? true;
    // A planilha é lida antes da transação (o .xlsx é pesado); a validação
    // contra o período e os momentos existentes roda de novo lá dentro.
    const arquivo = await this.lerArquivo(dto, {
      maxLinhas: associadoSorteConfig().cronogramaMaxLinhas,
    });
    const resultado = await this.uow.executar(
      async (tx) => {
        const campanha = await this.travar(tx, id);
        this.exigirRascunho(campanha);
        const existentes = substituir ? [] : await tx.listarMomentos(id);
        const lido = arquivo.erros.length
          ? arquivo
          : revalidarCronograma(arquivo.linhas, {
              periodo: { inicio: campanha.inicio, fim: campanha.fim },
              existentes,
            });
        if (lido.erros.length > 0) {
          throw erro422(
            'CRONOGRAMA_INVALIDO',
            `O arquivo tem ${lido.erros.length} linha(s) com erro. Nada foi gravado.`,
            { erros: lido.erros.slice(0, 500) },
          );
        }
        const removidos = substituir ? await tx.removerMomentos(id) : 0;
        const criados = await tx.criarMomentos(
          id,
          lido.linhas.map((l) => ({
            liberaEm: l.liberaEm,
            creditos: l.creditos,
            descricao: l.descricao,
          })),
        );
        return { removidos, criados, baseOrigin: campanha.baseOrigin };
      },
      { longa: true },
    );
    this.logger.log(
      `${baseTag(resultado.baseOrigin)} cronograma da campanha #${id} importado por ${nomeDoAutor(autor)}: ${resultado.criados} momento(s) (${resultado.removidos} substituído(s))`,
    );
    return {
      campanhaId: id,
      criados: resultado.criados,
      removidos: resultado.removidos,
      campanha: await this.detalhar(id),
    };
  }

  async criarMomento(id: number, dto: MomentoDto) {
    await this.uow.executar(async (tx) => {
      const campanha = await this.travar(tx, id);
      this.exigirRascunho(campanha);
      const liberaEm = this.dentroDoPeriodo(campanha, dto.liberaEm);
      await tx.criarMomentos(id, [
        {
          liberaEm,
          creditos: dto.creditos,
          descricao: dto.descricao?.trim() || null,
        },
      ]);
    });
    return this.detalhar(id);
  }

  async atualizarMomento(
    id: number,
    momentoId: number,
    dto: AtualizarMomentoDto,
  ) {
    await this.uow.executar(async (tx) => {
      const campanha = await this.travar(tx, id);
      this.exigirRascunho(campanha);
      await this.exigirMomento(id, momentoId);
      await tx.atualizarMomento(momentoId, {
        ...(dto.liberaEm !== undefined
          ? { liberaEm: this.dentroDoPeriodo(campanha, dto.liberaEm) }
          : {}),
        ...(dto.creditos !== undefined ? { creditos: dto.creditos } : {}),
        ...(dto.descricao !== undefined
          ? { descricao: dto.descricao?.trim() || null }
          : {}),
      });
    });
    return this.detalhar(id);
  }

  async excluirMomento(id: number, momentoId: number): Promise<void> {
    await this.uow.executar(async (tx) => {
      this.exigirRascunho(await this.travar(tx, id));
      await this.exigirMomento(id, momentoId);
      await tx.removerMomentos(id, [momentoId]);
    });
  }

  /**
   * Publica e trava: grava o SHA-256 do cronograma. Exige a confirmação com
   * o nome da campanha, ao menos um momento, todos dentro do período e
   * nenhuma outra campanha publicada na base.
   */
  async publicar(id: number, dto: PublicarCampanhaDto, autor: SorteAutor) {
    const agora = new Date();
    const hash = await this.uow.executar(
      async (tx) => {
        const campanha = await this.travar(tx, id);
        this.exigirRascunho(campanha);
        if (
          dto.confirmacao.trim().toLowerCase() !==
          campanha.nome.trim().toLowerCase()
        ) {
          throw erro422(
            'CONFIRMACAO_INVALIDA',
            'Digite o nome da campanha exatamente como está para publicar',
          );
        }
        if (campanha.fim.getTime() <= agora.getTime()) {
          throw erro422(
            'PERIODO_INVALIDO',
            'O fim da campanha já passou: ajuste o período antes de publicar',
          );
        }
        const momentos = await tx.listarMomentos(id);
        if (momentos.length === 0) {
          throw erro422(
            'CRONOGRAMA_VAZIO',
            'Importe o cronograma de momentos premiados antes de publicar',
          );
        }
        const fora = momentos.filter(
          (m) =>
            m.liberaEm.getTime() < campanha.inicio.getTime() ||
            m.liberaEm.getTime() > campanha.fim.getTime(),
        );
        if (fora.length > 0) {
          throw erro422(
            'MOMENTOS_FORA_DO_PERIODO',
            `${fora.length} momento(s) fora do período da campanha`,
          );
        }
        if ((await tx.contarCampanhasPublicadas(campanha.baseOrigin, id)) > 0) {
          throw erro409(
            'CAMPANHA_JA_PUBLICADA',
            'Já existe uma campanha publicada nesta base. Encerre-a antes.',
          );
        }
        const hashCalculado = hashCronograma(campanha, momentos);
        await tx.atualizarCampanha(id, {
          estado: SorteCampanhaEstado.PUBLICADA,
          publicadaEm: agora,
          publicadaPorId: autor.id,
          publicadaPorNome: autor.nome,
          hashCronograma: hashCalculado,
        });
        return {
          hash: hashCalculado,
          baseOrigin: campanha.baseOrigin,
          total: momentos.length,
        };
      },
      { longa: true },
    );
    this.logger.log(
      `${baseTag(hash.baseOrigin)} campanha #${id} PUBLICADA e travada por ${nomeDoAutor(autor)}: ${hash.total} momento(s), sha256 ${hash.hash}`,
    );
    return this.detalhar(id);
  }

  /** Encerramento (antecipado pelo painel ou pelo job no fim do período). */
  async encerrar(
    id: number,
    dto: EncerrarCampanhaDto,
    autor: SorteAutor | null,
  ) {
    const agora = new Date();
    const baseOrigin = await this.uow.executar(async (tx) => {
      const campanha = await this.travar(tx, id);
      if (campanha.estado === SorteCampanhaEstado.RASCUNHO) {
        throw erro409(
          'CAMPANHA_NAO_PUBLICADA',
          'Rascunho não é encerrado: exclua a campanha se não for usá-la',
        );
      }
      if (campanha.estado === SorteCampanhaEstado.ENCERRADA) {
        throw erro409('CAMPANHA_ENCERRADA', 'Esta campanha já foi encerrada');
      }
      await tx.atualizarCampanha(id, {
        estado: SorteCampanhaEstado.ENCERRADA,
        encerradaEm: agora,
        encerradaPorId: autor?.id ?? null,
        encerradaPorNome: autor ? autor.nome : AUTOR_SISTEMA,
        motivoEncerramento: dto.motivo.trim(),
      });
      return campanha.baseOrigin;
    });
    this.logger.log(
      `${baseTag(baseOrigin)} campanha #${id} ENCERRADA por ${autor ? nomeDoAutor(autor) : AUTOR_SISTEMA}: ${dto.motivo.trim()}`,
    );
    return this.detalhar(id);
  }

  /** Passo do job: encerra as campanhas publicadas cujo fim passou. */
  async encerrarVencidas(agora: Date): Promise<number> {
    let encerradas = 0;
    for (const id of await this.repository.listarPublicadasVencidas(agora)) {
      try {
        await this.encerrar(id, { motivo: 'Fim do período da campanha' }, null);
        encerradas++;
      } catch (erro) {
        this.logger.error(
          `Falha ao encerrar a campanha #${id}: ${(erro as Error).message}`,
        );
      }
    }
    return encerradas;
  }

  // -------------------------------------------------------------- auditoria

  /**
   * CSV de auditoria (`;`, UTF-8 com BOM, horários de Brasília), escrito em
   * lotes: dados da campanha e hash (o gravado e o recalculado agora), cada
   * momento com o ganhador e o histórico de raspadas da campanha.
   */
  async exportarAuditoria(
    id: number,
    escrever: (trecho: string) => void | Promise<void>,
  ): Promise<void> {
    const campanha = await this.exigir(id);
    const agora = new Date();
    const lote = associadoSorteConfig().auditoriaLote;
    const linha = (...campos: unknown[]) =>
      campos.map(campoCsv).join(';') + '\r\n';

    // Hash recalculado com o cronograma atual (deve bater com o publicado).
    const todos: {
      id: number;
      liberaEm: Date;
      creditos: number;
      descricao: string | null;
    }[] = [];
    for (let depois = 0; ; ) {
      const parte = await this.repository.lerMomentosEmLote(id, depois, lote);
      if (parte.length === 0) break;
      todos.push(...parte);
      depois = parte[parte.length - 1].id;
    }
    const hashAgora = hashCronograma(campanha, todos);

    await escrever('\uFEFF');
    await escrever(linha('ASSOCIADO DA SORTE - AUDITORIA DA CAMPANHA'));
    await escrever(linha('campo', 'valor'));
    await escrever(linha('campanha_id', campanha.id));
    await escrever(linha('nome', campanha.nome));
    await escrever(linha('base', campanha.baseOrigin));
    await escrever(linha('inicio', dataHoraBrasilia(campanha.inicio)));
    await escrever(linha('fim', dataHoraBrasilia(campanha.fim)));
    await escrever(linha('estado', campanha.estado));
    await escrever(
      linha('publicada_em', dataHoraBrasilia(campanha.publicadaEm)),
    );
    await escrever(
      linha(
        'publicada_por',
        campanha.publicadaPorNome ?? campanha.publicadaPorId ?? '',
      ),
    );
    await escrever(
      linha('hash_cronograma_sha256', campanha.hashCronograma ?? ''),
    );
    await escrever(linha('hash_recalculado_sha256', hashAgora));
    await escrever(
      linha(
        'hash_confere',
        campanha.hashCronograma
          ? campanha.hashCronograma === hashAgora
            ? 'SIM'
            : 'NAO'
          : '',
      ),
    );
    await escrever(
      linha('encerrada_em', dataHoraBrasilia(campanha.encerradaEm)),
    );
    await escrever(linha('encerrada_por', campanha.encerradaPorNome ?? ''));
    await escrever(
      linha('motivo_encerramento', campanha.motivoEncerramento ?? ''),
    );
    await escrever(linha('total_momentos', todos.length));
    await escrever(linha('gerado_em', dataHoraBrasilia(agora)));
    await escrever('\r\n');

    await escrever(linha('MOMENTOS PREMIADOS'));
    await escrever(
      linha(
        'momento_id',
        'libera_em',
        'creditos',
        'descricao',
        'status',
        'ganhador',
        'cpf',
        'raspada_id',
        'hora_da_raspada',
      ),
    );
    for (let depois = 0; ; ) {
      const parte = await this.repository.lerMomentosEmLote(id, depois, lote);
      if (parte.length === 0) break;
      const horas = await this.repository.horaDasRaspadas(
        parte.map((m) => m.raspadaId).filter((r): r is number => r !== null),
      );
      let bloco = '';
      for (const m of parte) {
        const status = statusDoMomento(m, agora);
        bloco += linha(
          m.id,
          dataHoraBrasilia(m.liberaEm),
          m.creditos,
          m.descricao ?? '',
          SORTE_MOMENTO_STATUS_LABELS[status],
          m.ganhador?.name ?? '',
          m.ganhador ? mascararCpf(m.ganhador.cpf) : '',
          m.raspadaId ?? '',
          dataHoraBrasilia(m.raspadaId ? horas.get(m.raspadaId) : null),
        );
      }
      await escrever(bloco);
      depois = parte[parte.length - 1].id;
    }
    await escrever('\r\n');

    await escrever(linha('RASPADAS'));
    await escrever(
      linha(
        'raspada_id',
        'data_hora',
        'associado',
        'cpf',
        'resultado',
        'creditos',
        'bonus_jornada',
        'momento_id',
      ),
    );
    for (let depois = 0; ; ) {
      const parte = await this.repository.lerRaspadasEmLote(id, depois, lote);
      if (parte.length === 0) break;
      let bloco = '';
      for (const r of parte) {
        bloco += linha(
          r.id,
          dataHoraBrasilia(r.createdAt),
          r.user?.name ?? `#${r.userId}`,
          mascararCpf(r.user?.cpf),
          r.resultado,
          r.creditos,
          r.bonus,
          r.momentoId ?? '',
        );
      }
      await escrever(bloco);
      depois = parte[parte.length - 1].id;
    }
  }

  // --------------------------------------------------------------- internos

  /** CSV ou .xlsx (planilha oficial) → linhas validadas + conferência. */
  private async lerArquivo(
    dto: ImportarCronogramaDto,
    opcoes: OpcoesCronograma,
  ): Promise<CronogramaXlsxLido> {
    if (dto.xlsxBase64) {
      return lerCronogramaXlsx(Buffer.from(dto.xlsxBase64, 'base64'), opcoes);
    }
    return {
      ...lerCronogramaCsv(dto.csv ?? '', opcoes),
      aba: '',
      titulo: [],
      resumo: [],
      avisos: [],
    };
  }

  private async exigir(id: number): Promise<SorteCampanha> {
    const campanha = await this.repository.buscar(id);
    if (!campanha) throw new NotFoundException('Campanha não encontrada');
    return campanha;
  }

  private async travar(tx: SorteTx, id: number): Promise<CampanhaTravada> {
    const campanha = await tx.travarCampanha(id);
    if (!campanha) throw new NotFoundException('Campanha não encontrada');
    return campanha;
  }

  private async exigirMomento(campanhaId: number, momentoId: number) {
    const momento = await this.repository.buscarMomento(momentoId);
    if (!momento || momento.campanhaId !== campanhaId) {
      throw new NotFoundException('Momento não encontrado');
    }
  }

  /** 409 `CAMPANHA_TRAVADA` fora do rascunho (publicada ou encerrada). */
  private exigirRascunho(campanha: { estado: SorteCampanhaEstado }): void {
    if (campanha.estado !== SorteCampanhaEstado.RASCUNHO) {
      throw erro409(
        'CAMPANHA_TRAVADA',
        'A campanha foi publicada e o cronograma está travado (auditoria). Não é possível alterar momentos nem o período.',
      );
    }
  }

  private periodo(inicioIso: string, fimIso: string) {
    const inicio = new Date(inicioIso);
    const fim = new Date(fimIso);
    if (
      Number.isNaN(inicio.getTime()) ||
      Number.isNaN(fim.getTime()) ||
      fim.getTime() <= inicio.getTime()
    ) {
      throw erro422('PERIODO_INVALIDO', 'O fim precisa ser depois do início');
    }
    return { inicio, fim };
  }

  private dentroDoPeriodo(campanha: CampanhaTravada, iso: string): Date {
    const liberaEm = new Date(iso);
    if (
      liberaEm.getTime() < campanha.inicio.getTime() ||
      liberaEm.getTime() > campanha.fim.getTime()
    ) {
      throw erro422(
        'MOMENTOS_FORA_DO_PERIODO',
        'O horário do momento precisa estar dentro do período da campanha',
      );
    }
    return liberaEm;
  }
}

function nomeDoAutor(autor: SorteAutor): string {
  return autor.nome ?? (autor.id ? `#${autor.id}` : 'sistema');
}
