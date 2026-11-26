/**
 * Etapas da régua de notificações (documento "Régua de notificações push —
 * vencimento do boleto mensal", versão 10/09/2026):
 *  DM5 = D-5 (boleto disponível) · D0 = vence hoje · D1 = D+1 (lembrete leve)
 *  D5 = D+5 (último dia com proteção) · D6 = D+6 (proteção suspensa)
 *  D20 = D+20 (último dia sem nova vistoria)
 */
export type TipoMensagem = 'DM5' | 'D0' | 'D1' | 'D5' | 'D6' | 'D20';

export const TIPOS_MENSAGEM: TipoMensagem[] = [
  'DM5',
  'D0',
  'D1',
  'D5',
  'D6',
  'D20',
];

/** Texto de uma etapa, com os tokens ainda por substituir. */
export interface ModeloDeMensagem {
  titulo: string;
  corpo: string;
}

/** O que a régua precisa da configuração para calcular as janelas. */
export interface RegrasDeJanela {
  /**
   * Offsets em dias corridos a partir de D (vencimento efetivo). DM5 é a
   * etapa pré-vencimento: valor N = janela de D-N até D-1.
   */
  offsets: Record<TipoMensagem, number>;
  /** Dias de atraso ALÉM do D+20 que ainda recebem a mensagem D+20. */
  alcanceD20: number;
}
