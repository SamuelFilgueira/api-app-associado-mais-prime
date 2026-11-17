import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SorteEstoqueMovimentoTipo } from '@prisma/client';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import {
  AtualizarPremioDto,
  CriarPremioDto,
  ListarPremiosQuery,
  MovimentarEstoqueDto,
} from 'src/associado-sorte/dto/premio.dto';
import { SorteAutor } from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro409, erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import { metaPaginacao } from 'src/associado-sorte/helpers/sorte.helpers';
import {
  PremioAdminView,
  toMovimentoEstoque,
  toPremioAdmin,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

/** Prêmios físicos e controle de estoque com histórico (seção 4.4). */
@Injectable()
export class SortePremiosService {
  private readonly logger = new Logger(SortePremiosService.name);

  constructor(
    private readonly repository: SortePremiosRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly fileUploadService: FileUploadService,
  ) {}

  async listar(query: ListarPremiosQuery) {
    const busca = query.busca?.trim();
    const where: Prisma.SortePremioWhereInput = {
      deletedAt: null,
      ...(busca ? { nome: { contains: busca } } : {}),
      ...(query.ativo !== undefined
        ? { ativo: query.ativo.toLowerCase() === 'true' }
        : {}),
      ...(query.naLoja !== undefined
        ? { naLoja: query.naLoja.toLowerCase() === 'true' }
        : {}),
      ...(query.tipo ? { tipo: query.tipo } : {}),
    };
    const { data, total } = await this.repository.listar({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const reservado = await this.repository.reservadoPorPremio(
      data.map((p) => p.id),
    );
    return {
      data: data.map((p) => toPremioAdmin(p, reservado.get(p.id) ?? 0)),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  async detalhar(id: number): Promise<PremioAdminView> {
    const premio = await this.repository.buscar(id);
    if (!premio) throw new NotFoundException('Prêmio não encontrado');
    const reservado = await this.repository.reservadoPorPremio([id]);
    return toPremioAdmin(premio, reservado.get(id) ?? 0);
  }

  async criar(
    dto: CriarPremioDto,
    autor: SorteAutor,
  ): Promise<PremioAdminView> {
    exigirPrecoNaLoja(dto.naLoja ?? false, dto.custoCreditos ?? 0);
    const premio = await this.repository.criar({
      nome: dto.nome.trim(),
      descricao: dto.descricao?.trim() || null,
      valorEstimado: dto.valorEstimado ?? null,
      ativo: dto.ativo ?? true,
      tipo: dto.tipo ?? 'FISICO',
      custoCreditos: dto.custoCreditos ?? 0,
      naLoja: dto.naLoja ?? false,
      limitePorAssociado: dto.limitePorAssociado ?? 0,
      instrucoesRetirada: dto.instrucoesRetirada?.trim() || null,
      ordem: dto.ordem ?? 0,
    });
    if (dto.estoqueInicial && dto.estoqueInicial > 0) {
      await this.movimentarEstoque(
        premio.id,
        {
          tipo: 'ENTRADA',
          quantidade: dto.estoqueInicial,
          motivo: 'Estoque inicial',
        },
        autor,
      );
    }
    this.logger.log(`Prêmio #${premio.id} criado por ${nomeDoAutor(autor)}`);
    return this.detalhar(premio.id);
  }

  /** Produtos da loja continuam editáveis com campanha publicada. */
  async atualizar(
    id: number,
    dto: AtualizarPremioDto,
  ): Promise<PremioAdminView> {
    const atual = await this.detalhar(id);
    exigirPrecoNaLoja(
      dto.naLoja ?? atual.naLoja,
      dto.custoCreditos ?? atual.custoCreditos,
    );
    await this.repository.atualizar(id, {
      ...(dto.tipo !== undefined ? { tipo: dto.tipo } : {}),
      ...(dto.custoCreditos !== undefined
        ? { custoCreditos: dto.custoCreditos }
        : {}),
      ...(dto.naLoja !== undefined ? { naLoja: dto.naLoja } : {}),
      ...(dto.limitePorAssociado !== undefined
        ? { limitePorAssociado: dto.limitePorAssociado }
        : {}),
      ...(dto.instrucoesRetirada !== undefined
        ? { instrucoesRetirada: dto.instrucoesRetirada?.trim() || null }
        : {}),
      ...(dto.ordem !== undefined ? { ordem: dto.ordem } : {}),
      ...(dto.nome !== undefined ? { nome: dto.nome.trim() } : {}),
      ...(dto.descricao !== undefined
        ? { descricao: dto.descricao?.trim() || null }
        : {}),
      ...(dto.valorEstimado !== undefined
        ? { valorEstimado: dto.valorEstimado }
        : {}),
      ...(dto.ativo !== undefined ? { ativo: dto.ativo } : {}),
    });
    return this.detalhar(id);
  }

  /** Exclusão lógica; recusada enquanto houver rodada publicada do prêmio. */
  async excluir(id: number): Promise<void> {
    await this.detalhar(id);
    const vivas = await this.repository.contarRodadasVivas(id);
    if (vivas > 0) {
      throw erro409(
        'PREMIO_EM_USO',
        'Este prêmio tem rodada publicada. Cancele ou aguarde o encerramento.',
      );
    }
    await this.repository.excluirLogico(id);
  }

  async salvarImagem(
    id: number,
    arquivo?: Express.Multer.File,
  ): Promise<PremioAdminView> {
    if (!arquivo)
      throw new BadRequestException('Envie o arquivo no campo "imagem"');
    const premio = await this.detalhar(id);
    // Upload fora de qualquer transação.
    const imagemUrl = await this.fileUploadService.uploadSortePremioImagem(
      arquivo,
      id,
    );
    await this.repository.atualizar(id, { imagemUrl });
    if (premio.imagemUrl) {
      await this.fileUploadService.deleteSortePremioImagem(premio.imagemUrl);
    }
    return this.detalhar(id);
  }

  /**
   * Entrada ou ajuste manual de estoque. Trava o prêmio, grava o movimento
   * com o estoque resultante e o autor, e nunca deixa o estoque negativo.
   */
  async movimentarEstoque(
    id: number,
    dto: MovimentarEstoqueDto,
    autor: SorteAutor,
  ): Promise<PremioAdminView> {
    if (dto.tipo === 'ENTRADA' && dto.quantidade <= 0) {
      throw new BadRequestException('Entrada precisa de quantidade positiva');
    }

    await this.uow.executar(async (tx) => {
      const premio = await tx.travarPremio(id);
      if (!premio || premio.excluido) {
        throw new NotFoundException('Prêmio não encontrado');
      }
      const estoqueApos = premio.estoque + dto.quantidade;
      if (estoqueApos < 0) {
        throw erro422(
          'ESTOQUE_INSUFICIENTE',
          `O estoque atual é ${premio.estoque}; não dá para retirar ${Math.abs(dto.quantidade)}`,
        );
      }
      await tx.atualizarEstoque(id, estoqueApos);
      await tx.criarMovimentoEstoque({
        premioId: id,
        tipo:
          dto.tipo === 'ENTRADA'
            ? SorteEstoqueMovimentoTipo.ENTRADA
            : SorteEstoqueMovimentoTipo.AJUSTE,
        quantidade: dto.quantidade,
        estoqueApos,
        motivo: dto.motivo.trim(),
        autorId: autor.id,
        autorNome: autor.nome,
      });
    });

    this.logger.log(
      `Estoque do prêmio #${id}: ${dto.tipo} de ${dto.quantidade} por ${nomeDoAutor(autor)}`,
    );
    return this.detalhar(id);
  }

  async listarMovimentos(id: number, query: PaginacaoQuery) {
    await this.detalhar(id);
    const { data, total } = await this.repository.listarMovimentos({
      premioId: id,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map(toMovimentoEstoque),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }
}

function nomeDoAutor(autor: SorteAutor): string {
  return autor.nome ?? (autor.id ? `#${autor.id}` : 'sistema');
}

/** Produto na loja precisa de preço (422 `CUSTO_INVALIDO`). */
function exigirPrecoNaLoja(naLoja: boolean, custoCreditos: number): void {
  if (naLoja && custoCreditos < 1) {
    throw erro422(
      'CUSTO_INVALIDO',
      'Produto na Loja da Sorte precisa de preço em créditos (mínimo 1)',
    );
  }
}
