import { Injectable, NotFoundException } from '@nestjs/common';
import { erro403 } from 'src/associado-sorte/helpers/sorte-erros';
import { SorteConfigView } from 'src/associado-sorte/mappers/sorte.mapper';
import {
  SorteCreditosRepository,
  UsuarioSorte,
} from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import {
  SituacaoInscricao,
  SorteInscricaoService,
} from 'src/associado-sorte/services/sorte-inscricao.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';

export interface AcessoValidado {
  config: SorteConfigView;
  usuario: UsuarioSorte;
  inscricao: SituacaoInscricao;
}

/**
 * Elegibilidade validada no servidor: base contemplada com a promoção
 * ativa (403 `PROMOCAO_INATIVA`), cadastro ativo (403 `ASSOCIADO_INATIVO`) e
 * inscrição no produto do SGA (403 `NAO_INSCRITO`, com `motivo`).
 */
@Injectable()
export class SorteAcessoService {
  constructor(
    private readonly config: SorteConfigService,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly inscricao: SorteInscricaoService,
    private readonly tentativas: SorteTentativaService,
  ) {}

  /**
   * `registrarTentativa: false` quando quem chama já registra a falha no
   * próprio `catch` (raspar e comprar), para não gravar duas vezes.
   */
  async validar(
    userId: number,
    baseOrigin: string,
    opcoes: { registrarTentativa?: boolean; rota?: string } = {},
  ): Promise<AcessoValidado> {
    const config = await this.config.exigirAtiva(baseOrigin);
    const usuario = await this.creditosRepository.buscarUsuario(userId);
    if (!usuario?.isActive) {
      throw erro403(
        'ASSOCIADO_INATIVO',
        'Seu cadastro não está ativo para participar',
      );
    }
    const inscricao = await this.inscricao.situacao(userId, baseOrigin, config);
    if (!inscricao.inscrito) {
      if (opcoes.registrarTentativa !== false) {
        this.tentativas.registrar({
          userId,
          baseOrigin,
          acao: 'ACESSAR',
          codigo: 'NAO_INSCRITO',
          contexto: { motivo: inscricao.motivo, rota: opcoes.rota },
        });
      }
      throw erro403(
        'NAO_INSCRITO',
        inscricao.motivo === 'VERIFICACAO_INDISPONIVEL'
          ? 'Não foi possível confirmar sua inscrição agora. Tente mais tarde.'
          : 'Você ainda não está inscrito no Associado da Sorte',
        { motivo: inscricao.motivo },
      );
    }
    return { config, usuario, inscricao };
  }

  /** Rodadas e "Avise-me" no app: 404 com `rodadasHabilitadas` desligado. */
  async exigirRodadasHabilitadas(baseOrigin: string): Promise<void> {
    const config = await this.config.obter(baseOrigin).catch(() => null);
    if (!config?.rodadasHabilitadas) {
      throw new NotFoundException('Rodada não encontrada');
    }
  }
}
