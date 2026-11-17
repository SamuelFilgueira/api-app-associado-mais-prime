import {
  SorteCampanhaEstado,
  SorteEstoqueMovimentoTipo,
  SorteFonteCredito,
  SorteGanhadorOrigem,
  SorteGanhadorSituacao,
  SorteInscricaoFonte,
  SorteMecanica,
  SorteModoCredito,
  SorteNotificacaoAdminTipo,
  SorteProdutoTipo,
  SorteRaspadaResultado,
  SorteRodadaEstado,
  SorteTentativaAcao,
} from '@prisma/client';

export {
  SorteCampanhaEstado,
  SorteEstoqueMovimentoTipo,
  SorteFonteCredito,
  SorteGanhadorOrigem,
  SorteGanhadorSituacao,
  SorteInscricaoFonte,
  SorteMecanica,
  SorteModoCredito,
  SorteNotificacaoAdminTipo,
  SorteProdutoTipo,
  SorteRaspadaResultado,
  SorteRodadaEstado,
  SorteTentativaAcao,
};

/**
 * Tipos de lançamento do extrato. A coluna é `VARCHAR`, então uma fonte nova
 * de crédito (boleto em dia, indicação, abastecimento) entra aqui e em
 * `SORTE_LANCAMENTO_LABELS`, sem migration.
 */
export const SorteLancamentoTipo = {
  RASPADINHA: 'RASPADINHA',
  CHECKIN: 'CHECKIN',
  BONUS_SEQUENCIA: 'BONUS_SEQUENCIA',
  AJUSTE_ADMIN: 'AJUSTE_ADMIN',
  PARTICIPACAO_SORTEIO: 'PARTICIPACAO_SORTEIO',
  RESGATE: 'RESGATE',
  ESTORNO: 'ESTORNO',
  VOUCHER_RASPADINHA: 'VOUCHER_RASPADINHA',
  COMPRA_LOJA: 'COMPRA_LOJA',
} as const;
export type SorteLancamentoTipo =
  (typeof SorteLancamentoTipo)[keyof typeof SorteLancamentoTipo];

/** Fase exibida no app, calculada pelo relógio do servidor (sem job). */
export enum SorteFase {
  EM_BREVE = 'EM_BREVE',
  ABERTA = 'ABERTA',
  ESGOTADA = 'ESGOTADA',
  APURANDO = 'APURANDO',
  ENCERRADA = 'ENCERRADA',
}

export const SORTE_BASE_LABELS: Record<string, string> = {
  MAIS_PRIME: 'Mais Prime',
  MAIS_PRIME_RS: 'Mais Prime RS',
};

export const SORTE_MECANICA_LABELS: Record<SorteMecanica, string> = {
  SORTEIO: 'Sorteio',
  CORRIDA: 'Corrida (primeiro que clicar leva)',
  RESGATE: 'Vitrine (troca por créditos)',
};

export const SORTE_MODO_CREDITO_LABELS: Record<SorteModoCredito, string> = {
  CONSOME: 'Consome créditos',
  SALDO_MINIMO: 'Saldo mínimo (não debita)',
};

export const SORTE_ESTADO_LABELS: Record<SorteRodadaEstado, string> = {
  RASCUNHO: 'Rascunho',
  PUBLICADA: 'Publicada',
  APURANDO: 'Apurando',
  ENCERRADA: 'Encerrada',
  CANCELADA: 'Cancelada',
};

export const SORTE_FASE_LABELS: Record<SorteFase, string> = {
  EM_BREVE: 'Em breve',
  ABERTA: 'Aberta',
  ESGOTADA: 'Esgotada',
  APURANDO: 'Apurando',
  ENCERRADA: 'Encerrada',
};

export const SORTE_FONTE_LABELS: Record<SorteFonteCredito, string> = {
  RASPADINHA: 'Raspadinha (valor sorteado)',
  CHECKIN: 'Check-in (valor fixo)',
  NENHUMA: 'Nenhuma',
};

export const SORTE_SITUACAO_LABELS: Record<SorteGanhadorSituacao, string> = {
  AGUARDANDO_CONTATO: 'Aguardando contato',
  EM_CONTATO: 'Em contato',
  ENTREGUE: 'Entregue',
  CANCELADO: 'Cancelado',
};

export const SORTE_MOVIMENTO_LABELS: Record<SorteEstoqueMovimentoTipo, string> =
  {
    ENTRADA: 'Entrada',
    SAIDA_GANHADOR: 'Saída (ganhador)',
    AJUSTE: 'Ajuste',
    ESTORNO: 'Estorno',
  };

export const SORTE_LANCAMENTO_LABELS: Record<string, string> = {
  RASPADINHA: 'Raspadinha',
  CHECKIN: 'Check-in diário',
  BONUS_SEQUENCIA: 'Bônus de sequência',
  AJUSTE_ADMIN: 'Ajuste da equipe',
  PARTICIPACAO_SORTEIO: 'Participação em sorteio',
  RESGATE: 'Resgate de prêmio',
  ESTORNO: 'Estorno',
  VOUCHER_RASPADINHA: 'Voucher da raspadinha',
  COMPRA_LOJA: 'Compra na Loja da Sorte',
};

export const SORTE_PRODUTO_TIPO_LABELS: Record<SorteProdutoTipo, string> = {
  FISICO: 'Produto físico',
  SERVICO_MAIS_PRIME: 'Serviço Mais Prime',
  CUPOM_PARCEIRO: 'Cupom de parceiro',
};

export const SORTE_ORIGEM_LABELS: Record<SorteGanhadorOrigem, string> = {
  SORTEIO: 'Sorteio',
  CORRIDA: 'Corrida',
  RESGATE: 'Vitrine',
  LOJA: 'Loja da Sorte',
};

export const SORTE_CAMPANHA_ESTADO_LABELS: Record<SorteCampanhaEstado, string> =
  {
    RASCUNHO: 'Rascunho',
    PUBLICADA: 'Publicada (travada)',
    ENCERRADA: 'Encerrada',
  };

export const SORTE_RASPADA_RESULTADO_LABELS: Record<
  SorteRaspadaResultado,
  string
> = {
  GANHOU: 'Ganhou voucher',
  NAO_GANHOU: 'Não foi dessa vez',
};

export const SORTE_INSCRICAO_FONTE_LABELS: Record<SorteInscricaoFonte, string> =
  {
    SGA: 'SGA',
    MANUAL: 'Marcação manual',
  };

export const SORTE_TENTATIVA_ACAO_LABELS: Record<SorteTentativaAcao, string> = {
  RASPAR: 'raspar',
  COMPRAR: 'comprar na loja',
  ACESSAR: 'acessar a promoção',
};

export const SORTE_NOTIFICACAO_TIPO_LABELS: Record<
  SorteNotificacaoAdminTipo,
  string
> = {
  NOVA_RETIRADA: 'Nova retirada',
  ESTOQUE_BAIXO: 'Estoque baixo',
  ESTOQUE_ESGOTADO: 'Estoque esgotado',
};

/** Status do momento premiado, calculado pelo relógio do servidor. */
export type SorteMomentoStatus = 'AGUARDANDO' | 'DISPONIVEL' | 'GANHO';

export const SORTE_MOMENTO_STATUS_LABELS: Record<SorteMomentoStatus, string> = {
  AGUARDANDO: 'Aguardando o horário',
  DISPONIVEL: 'Liberado, sem ganhador',
  GANHO: 'Ganho',
};

/** Mensagem curta de cada código de erro, para o extrato de tentativas. */
export const SORTE_ERRO_LABELS: Record<string, string> = {
  NAO_INSCRITO: 'não está inscrito no Associado da Sorte',
  LIMITE_DIARIO: 'já usou todas as raspadas do dia',
  INTERVALO: 'ainda não cumpriu o intervalo entre raspadas',
  SEM_CAMPANHA: 'não havia campanha publicada',
  CAMPANHA_FORA_DO_PERIODO: 'fora do período da campanha',
  ESGOTADO: 'produto esgotado',
  LIMITE_POR_ASSOCIADO: 'atingiu o limite de compras deste produto',
  CREDITOS_INSUFICIENTES: 'créditos insuficientes',
  PROMOCAO_INATIVA: 'promoção desligada',
  ASSOCIADO_INATIVO: 'cadastro inativo',
  PRODUTO_INDISPONIVEL: 'produto fora da loja',
  TENTE_NOVAMENTE: 'sistema ocupado',
  ERRO_INTERNO: 'erro interno',
};

export interface SorteFaixaRaspadinha {
  creditos: number;
  peso: number;
}

export interface SorteMarcoSequencia {
  dias: number;
  bonus: number;
}

/** Quem executou uma ação do painel (vem do JWT do painel). */
export interface SorteAutor {
  id: number | null;
  nome: string | null;
}
