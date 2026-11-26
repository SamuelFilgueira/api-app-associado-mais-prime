import { SetMetadata } from '@nestjs/common';
import {
  FonteDeValor,
  NomeDaPolitica,
} from 'src/infra/rate-limit/rate-limit.politicas';

export const LIMITE_DE_TAXA_KEY = 'limite_de_taxa';

export interface OpcoesDoLimite {
  /** Troca o identificador padrão da política (ex.: `email` no painel). */
  identificador?: FonteDeValor;
}

export interface MetadadoDoLimite extends OpcoesDoLimite {
  politica: NomeDaPolitica | 'nenhuma';
}

/**
 * Escolhe a política de limite da rota (ou do controller inteiro).
 * `@LimiteDeTaxa('nenhuma')` isenta a rota — só para sondas e webhooks
 * autenticados por assinatura.
 */
export const LimiteDeTaxa = (
  politica: NomeDaPolitica | 'nenhuma',
  opcoes: OpcoesDoLimite = {},
) => SetMetadata(LIMITE_DE_TAXA_KEY, { politica, ...opcoes });
