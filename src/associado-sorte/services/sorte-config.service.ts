import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isTenantBase } from 'src/config/tenant.config';
import { baseContemplada } from 'src/associado-sorte/config/associado-sorte.config';
import { SalvarConfigDto } from 'src/associado-sorte/dto/salvar-config.dto';
import {
  SorteAutor,
  SorteFonteCredito,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { erro403, erro422 } from 'src/associado-sorte/helpers/sorte-erros';
import {
  normalizarTelefone,
  validarFaixas,
  validarMarcos,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  SorteConfigView,
  toConfigView,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteConfigRepository } from 'src/associado-sorte/repositories/sorte-config.repository';
import { baseTag } from 'src/shared/log.util';

/** Configuração da promoção por base (liga/desliga, crédito diário, textos). */
@Injectable()
export class SorteConfigService {
  private readonly logger = new Logger(SorteConfigService.name);

  constructor(private readonly repository: SorteConfigRepository) {}

  /** Configuração da base; sem linha gravada, devolve os valores padrão. */
  async obter(baseOrigin: string): Promise<SorteConfigView> {
    this.exigirBaseValida(baseOrigin);
    return toConfigView(baseOrigin, await this.repository.buscar(baseOrigin));
  }

  /**
   * 403 `PROMOCAO_INATIVA` quando a promoção está desligada na base ou a base
   * não está em `SORTE_BASES_CONTEMPLADAS`.
   */
  async exigirAtiva(baseOrigin: string): Promise<SorteConfigView> {
    const config =
      isTenantBase(baseOrigin) && baseContemplada(baseOrigin)
        ? toConfigView(baseOrigin, await this.repository.buscar(baseOrigin))
        : null;
    if (!config?.ativa) {
      throw erro403(
        'PROMOCAO_INATIVA',
        'A promoção não está disponível no momento',
      );
    }
    return config;
  }

  async salvar(
    baseOrigin: string,
    dto: SalvarConfigDto,
    autor: SorteAutor,
  ): Promise<SorteConfigView> {
    const atual = await this.obter(baseOrigin);

    const fonte = dto.fonteCreditoDiario ?? atual.fonteCreditoDiario;
    const faixas = dto.faixasRaspadinha ?? atual.faixasRaspadinha;
    const marcos = dto.marcosSequencia ?? atual.marcosSequencia;

    if (dto.faixasRaspadinha || fonte === SorteFonteCredito.RASPADINHA) {
      const problema = validarFaixas(faixas);
      if (problema) throw erro422('FAIXAS_INVALIDAS', problema);
    }
    const problemaMarcos = validarMarcos(marcos);
    if (problemaMarcos) throw erro422('FAIXAS_INVALIDAS', problemaMarcos);

    let whatsappSuporte = atual.whatsappSuporte;
    if (dto.whatsappSuporte !== undefined) {
      const informado = (dto.whatsappSuporte ?? '').trim();
      whatsappSuporte = informado ? normalizarTelefone(informado) : null;
      if (informado && !whatsappSuporte) {
        throw erro422(
          'TELEFONE_INVALIDO',
          'WhatsApp de suporte inválido: informe DDD + número',
        );
      }
    }

    const whatsappConvite = this.telefoneOpcional(
      dto.whatsappConvite,
      atual.whatsappConvite,
      'WhatsApp do convite',
    );
    const whatsappMarketing = this.telefoneOpcional(
      dto.whatsappMarketing,
      atual.whatsappMarketing,
      'WhatsApp do marketing',
    );
    let emailNotificacoes = atual.emailNotificacoes;
    if (dto.emailNotificacoes !== undefined) {
      const emails = separarEmails(dto.emailNotificacoes);
      const invalido = emails.find((e) => !EMAIL.test(e));
      if (invalido) {
        throw erro422('EMAIL_INVALIDO', `E-mail inválido: ${invalido}`);
      }
      emailNotificacoes = emails.join(', ');
    }

    const regulamento =
      dto.regulamento !== undefined
        ? (dto.regulamento ?? '').trim() || null
        : atual.regulamento;
    const regulamentoMudou = regulamento !== atual.regulamento;

    const salvo = await this.repository.salvar(baseOrigin, {
      ativa: dto.ativa ?? atual.ativa,
      titulo: (dto.titulo ?? atual.titulo).trim() || 'Associado da Sorte',
      subtitulo:
        dto.subtitulo !== undefined
          ? (dto.subtitulo ?? '').trim() || null
          : atual.subtitulo,
      regulamento,
      regulamentoAtualizadoEm: regulamentoMudou
        ? new Date()
        : atual.regulamentoAtualizadoEm,
      whatsappSuporte,
      fonteCreditoDiario: fonte,
      faixasRaspadinha: [...faixas]
        .sort((a, b) => a.creditos - b.creditos)
        .map((f) => ({
          creditos: f.creditos,
          peso: f.peso,
        })) as unknown as Prisma.InputJsonValue,
      creditosCheckin: dto.creditosCheckin ?? atual.creditosCheckin,
      marcosSequencia: [...marcos]
        .sort((a, b) => a.dias - b.dias)
        .map((m) => ({
          dias: m.dias,
          bonus: m.bonus,
        })) as unknown as Prisma.InputJsonValue,
      exibirGanhadores: dto.exibirGanhadores ?? atual.exibirGanhadores,
      carenciaDias: dto.carenciaDias ?? atual.carenciaDias,
      produtoSgaCodigo: (dto.produtoSgaCodigo ?? atual.produtoSgaCodigo).trim(),
      produtoSgaDescricao: (
        dto.produtoSgaDescricao ?? atual.produtoSgaDescricao
      ).trim(),
      inscricaoValidadeHoras:
        dto.inscricaoValidadeHoras ?? atual.inscricaoValidadeHoras,
      raspadasPorDia: dto.raspadasPorDia ?? atual.raspadasPorDia,
      intervaloMinimoMinutos:
        dto.intervaloMinimoMinutos ?? atual.intervaloMinimoMinutos,
      jornadaAtiva: dto.jornadaAtiva ?? atual.jornadaAtiva,
      lembretesAtivos: dto.lembretesAtivos ?? atual.lembretesAtivos,
      lembreteInicio: dto.lembreteInicio ?? atual.lembreteInicio,
      lembreteFim: dto.lembreteFim ?? atual.lembreteFim,
      whatsappConvite,
      mensagemConvite: (dto.mensagemConvite ?? atual.mensagemConvite).trim(),
      emailNotificacoes,
      whatsappMarketing,
      rodadasHabilitadas: dto.rodadasHabilitadas ?? atual.rodadasHabilitadas,
    });

    this.logger.log(
      `${baseTag(baseOrigin)} configuração do Associado da Sorte salva por ${autor.nome ?? `#${autor.id}`} (ativa=${salvo.ativa}, raspadas/dia=${salvo.raspadasPorDia}, intervalo=${salvo.intervaloMinimoMinutos}min, jornada=${salvo.jornadaAtiva}, rodadas=${salvo.rodadasHabilitadas})`,
    );
    return toConfigView(baseOrigin, salvo);
  }

  /** Campo de WhatsApp opcional: vazio/null remove; inválido → 422. */
  private telefoneOpcional(
    informado: string | null | undefined,
    atual: string | null,
    rotulo: string,
  ): string | null {
    if (informado === undefined) return atual;
    const texto = (informado ?? '').trim();
    if (!texto) return null;
    const numero = normalizarTelefone(texto);
    if (!numero) {
      throw erro422(
        'TELEFONE_INVALIDO',
        `${rotulo} inválido: informe DDD + número`,
      );
    }
    return numero;
  }

  private exigirBaseValida(baseOrigin: string): void {
    if (!isTenantBase(baseOrigin)) {
      throw erro422(
        'BASE_INVALIDA',
        `Base desconhecida: ${String(baseOrigin)}`,
      );
    }
  }
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"] (sem vazios e sem repetidos). */
export function separarEmails(valor: string | null | undefined): string[] {
  return [
    ...new Set(
      String(valor ?? '')
        .split(/[,;]/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
