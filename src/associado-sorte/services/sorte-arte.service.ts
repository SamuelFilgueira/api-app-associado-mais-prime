import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isTenantBase } from 'src/config/tenant.config';
import { SorteAutor } from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  SORTE_ARTE_CAMPO,
  SORTE_ARTE_ESPEC,
  SORTE_ARTE_SLOTS,
  SorteArteSlot,
  ehSlotDeArte,
  validarArte,
} from 'src/associado-sorte/helpers/sorte-arte.helper';
import { erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import {
  SorteArtesView,
  toConfigView,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteConfigRepository } from 'src/associado-sorte/repositories/sorte-config.repository';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { baseTag } from 'src/shared/log.util';

/**
 * Arte da raspadinha por base: capa (raspável), "ganhou" e "não ganhou".
 * As regras de medida/formato ficam em `helpers/sorte-arte.helper.ts`.
 */
@Injectable()
export class SorteArteService {
  private readonly logger = new Logger(SorteArteService.name);

  constructor(
    private readonly repository: SorteConfigRepository,
    private readonly fileUploadService: FileUploadService,
  ) {}

  /** Regras para o painel mostrar ao lado do upload. */
  especificacao() {
    return { slots: SORTE_ARTE_SLOTS, ...SORTE_ARTE_ESPEC };
  }

  async salvar(
    baseOrigin: string,
    slot: string,
    arquivo: Express.Multer.File | undefined,
    autor: SorteAutor,
  ): Promise<SorteArtesView> {
    const espaco = this.exigirSlot(baseOrigin, slot);
    if (!arquivo?.buffer?.length) {
      throw new BadRequestException('Envie o arquivo no campo "arte"');
    }
    const validada = await validarArte(espaco, arquivo.buffer);
    if (validada.ok === false) {
      throw erro422('ARTE_INVALIDA', validada.mensagem);
    }

    const campo = SORTE_ARTE_CAMPO[espaco];
    const anterior = (await this.repository.buscar(baseOrigin))?.[campo];
    // Upload fora de qualquer transação; o arquivo antigo só sai depois de gravar.
    const url = await this.fileUploadService.uploadSorteArte(arquivo, {
      nome: `${baseOrigin}-${espaco}`.toLowerCase(),
      animada: validada.arte.animada,
      formato: validada.arte.formato,
    });
    const salvo = await this.repository.atualizarParcial(baseOrigin, {
      [campo]: url,
    });
    if (anterior)
      await this.fileUploadService.deleteSortePremioImagem(anterior);

    this.logger.log(
      `${baseTag(baseOrigin)} arte da raspadinha "${espaco}" atualizada por ${nomeDoAutor(autor)} (${validada.arte.formato} ${validada.arte.largura}x${validada.arte.altura}${validada.arte.animada ? ', animada' : ''})`,
    );
    return toConfigView(baseOrigin, salvo).artes;
  }

  async remover(
    baseOrigin: string,
    slot: string,
    autor: SorteAutor,
  ): Promise<SorteArtesView> {
    const espaco = this.exigirSlot(baseOrigin, slot);
    const campo = SORTE_ARTE_CAMPO[espaco];
    const atual = await this.repository.buscar(baseOrigin);
    if (!atual?.[campo]) return toConfigView(baseOrigin, atual).artes;

    const salvo = await this.repository.atualizarParcial(baseOrigin, {
      [campo]: null,
    });
    await this.fileUploadService.deleteSortePremioImagem(atual[campo]);
    this.logger.log(
      `${baseTag(baseOrigin)} arte da raspadinha "${espaco}" removida por ${nomeDoAutor(autor)}`,
    );
    return toConfigView(baseOrigin, salvo).artes;
  }

  private exigirSlot(baseOrigin: string, slot: string): SorteArteSlot {
    if (!isTenantBase(baseOrigin)) {
      throw new BadRequestException('Base inválida');
    }
    if (!ehSlotDeArte(slot)) {
      throw new BadRequestException(
        `Espaço de arte inválido: use ${SORTE_ARTE_SLOTS.join(', ')}`,
      );
    }
    return slot;
  }
}

function nomeDoAutor(autor: SorteAutor): string {
  return autor.nome ?? (autor.id ? `#${autor.id}` : 'sistema');
}
