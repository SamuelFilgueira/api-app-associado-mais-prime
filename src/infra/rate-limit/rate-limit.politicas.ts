/**
 * Políticas de limite de requisições. Uma política por tipo de rota; a rota
 * escolhe a sua com `@LimiteDeTaxa('<nome>')`. Rota autenticada sem
 * decorator cai em `leitura`.
 *
 * Os números são PONTOS DE PARTIDA, a calibrar com a métrica
 * `rate_limit_hits_total{politica,resultado}`. Por isso as políticas de uso
 * comum nascem em modo `observar` (só medem); as de abuso evidente — força
 * bruta, recuperação de conta, comando de veículo e PDF — já nascem em
 * `aplicar`. `RATE_LIMIT_ENFORCE_ALL=true` aplica todas.
 *
 * Regra geral: rota autenticada nunca é limitada só por IP — operadoras
 * móveis colocam muitos aparelhos atrás do mesmo endereço.
 */

/** De onde sai o valor que identifica o alvo da requisição (CPF, chassi...). */
export interface FonteDeValor {
  corpo?: string;
  parametro?: string;
  query?: string;
  /** Mantém só os dígitos (CPF/CNPJ com ou sem máscara viram a mesma chave). */
  digitos?: boolean;
}

export type ChaveDeLimite =
  /** `userId` do token (cai para o IP se a rota for anônima). */
  | 'usuario'
  | 'ip'
  /** O identificador da rota (CPF do corpo, e-mail do login do painel...). */
  | 'identificador'
  /** Usuário + identificador (ex.: usuário e chassi). */
  | 'usuario_identificador';

export interface JanelaDeLimite {
  limite: number;
  janelaSeg: number;
  chave: ChaveDeLimite;
}

export interface PoliticaDeLimite {
  janelas: JanelaDeLimite[];
  /**
   * `todas`: cada requisição conta.
   * `falhas`: só as recusadas pelo handler (400/401/403/404/422) contam —
   * login certo nunca consome o limite de quem usa o app normalmente.
   */
  contar: 'todas' | 'falhas';
  /**
   * Com o Redis fora: `memoria` mantém o limite por processo (freio de força
   * bruta continua de pé); `libera` deixa passar.
   */
  redisFora: 'memoria' | 'libera';
  modo: 'aplicar' | 'observar';
  /** Requisições simultâneas por usuário (ex.: um PDF por vez). */
  simultaneos?: number;
  /** Identificador padrão da política; a rota pode trocar no decorator. */
  identificador?: FonteDeValor;
}

const MINUTO = 60;
const HORA = 3600;

export const POLITICAS_DE_LIMITE = {
  /** Login do app e do painel: freio de força bruta por conta e por IP. */
  autenticacao: {
    janelas: [
      { limite: 5, janelaSeg: MINUTO, chave: 'identificador' },
      { limite: 20, janelaSeg: HORA, chave: 'identificador' },
      { limite: 30, janelaSeg: MINUTO, chave: 'ip' },
    ],
    contar: 'falhas',
    redisFora: 'memoria',
    modo: 'aplicar',
    identificador: { corpo: 'cpf', digitos: true },
  },
  /**
   * Login na Alloyal. Mais folgado: o app tenta entrar, falha, realinha a
   * senha e tenta de novo a cada abertura quando a conta está dessincronizada.
   */
  autenticacao_alloyal: {
    janelas: [
      { limite: 10, janelaSeg: MINUTO, chave: 'usuario' },
      { limite: 60, janelaSeg: HORA, chave: 'usuario' },
    ],
    contar: 'falhas',
    redisFora: 'memoria',
    modo: 'aplicar',
  },
  /** Reset de senha: cada chamada dispara um e-mail. */
  recuperacao_senha: {
    janelas: [
      { limite: 3, janelaSeg: HORA, chave: 'identificador' },
      { limite: 20, janelaSeg: HORA, chave: 'ip' },
    ],
    contar: 'todas',
    redisFora: 'memoria',
    modo: 'aplicar',
    identificador: { corpo: 'cpf', digitos: true },
  },
  /**
   * Primeiro acesso (só com o CPF, por regra da associação). O limite por IP
   * é alto de propósito: em dia de campanha muitos associados fazem o
   * primeiro acesso pela mesma operadora.
   */
  primeiro_acesso: {
    janelas: [
      { limite: 5, janelaSeg: HORA, chave: 'identificador' },
      { limite: 60, janelaSeg: HORA, chave: 'ip' },
    ],
    contar: 'todas',
    redisFora: 'memoria',
    modo: 'aplicar',
    identificador: { corpo: 'cpf', digitos: true },
  },
  /** Padrão das rotas autenticadas. */
  leitura: {
    janelas: [{ limite: 120, janelaSeg: MINUTO, chave: 'usuario' }],
    contar: 'todas',
    redisFora: 'libera',
    modo: 'observar',
  },
  /** Rotas que consultam a Hinova (atendidas pelo cache). */
  sga: {
    janelas: [{ limite: 20, janelaSeg: MINUTO, chave: 'usuario' }],
    contar: 'todas',
    redisFora: 'libera',
    modo: 'observar',
  },
  /** Posição do veículo: uma consulta a cada 5 s por usuário e chassi. */
  posicao: {
    janelas: [
      { limite: 12, janelaSeg: MINUTO, chave: 'usuario_identificador' },
    ],
    contar: 'todas',
    redisFora: 'libera',
    modo: 'observar',
    identificador: { corpo: 'chassi' },
  },
  /** PDFs: três por minuto e um por vez por usuário. */
  relatorio: {
    janelas: [{ limite: 3, janelaSeg: MINUTO, chave: 'usuario' }],
    contar: 'todas',
    redisFora: 'memoria',
    modo: 'aplicar',
    simultaneos: 1,
  },
  /** Liga/desliga de âncora e alerta de ignição. */
  comando: {
    janelas: [{ limite: 6, janelaSeg: MINUTO, chave: 'usuario_identificador' }],
    contar: 'todas',
    redisFora: 'memoria',
    modo: 'aplicar',
    identificador: { corpo: 'chassi' },
  },
} as const satisfies Record<string, PoliticaDeLimite>;

export type NomeDaPolitica = keyof typeof POLITICAS_DE_LIMITE;

/** Política das rotas autenticadas sem `@LimiteDeTaxa`. */
export const POLITICA_PADRAO: NomeDaPolitica = 'leitura';
