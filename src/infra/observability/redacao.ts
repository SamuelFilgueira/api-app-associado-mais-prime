/**
 * Redação de dados sensíveis em linhas de log.
 *
 * Aplicada pelo logger a toda mensagem e stack: os ~390 pontos de log do
 * código escrevem texto livre, e vários interpolam CPF, URL do SGA com CPF,
 * corpo de resposta de vendor e, em alguns casos, token. Redigir no logger
 * cobre todos de uma vez, inclusive os que ainda serão escritos.
 */

const REDIGIDO = '[redigido]';

/** Chaves cujo valor nunca vai para o log, em qualquer nível do objeto. */
const CHAVES_SENSIVEIS =
  /^(authorization|password|senha|pass|passwordhash|token|access_?token|refresh_?token|token_usuario|tokenusuario|secret|segredo|api_?key|x-admin-token|x-m7-signature|cookie|set-cookie)$/i;

const PADROES_TEXTO: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Authorization: Bearer <token>
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDIGIDO}`],
  // JWT solto (três segmentos base64url começando por um header JSON)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  // "senha":"...", "token": "...", password=..., etc. em JSON ou query string
  [
    /(["']?(?:password|senha|passwordHash|token|access_token|refresh_token|token_usuario|authorization|secret|api_key)["']?\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi,
    `$1$2${REDIGIDO}$2`,
  ],
  // Expo push token: mantém só o suficiente para correlacionar
  [
    /\b(Expo(?:nent)?PushToken)\[([A-Za-z0-9_-]{4})[A-Za-z0-9_-]*\]/g,
    '$1[$2…]',
  ],
  // CPF formatado
  [/\b\d{3}\.\d{3}\.(\d{3})-(\d{2})\b/g, '***.***.$1-$2'],
  // CPF só com dígitos, quando o contexto diz que é documento
  [
    /((?:cpf|documento|cnpj)["']?\s*[:=#]?\s*["']?|\/(?:associado\/buscar|situacao-associado|verificar-situacao|cpf|users\/search)\/)(\d{6})(\d{3})(\d{2})\b/gi,
    '$1***.***.$3-$4',
  ],
];

/** Redige padrões sensíveis dentro de um texto livre. */
export function redigirTexto(texto: string): string {
  let saida = texto;
  for (const [padrao, troca] of PADROES_TEXTO) {
    saida = saida.replace(padrao, troca as string);
  }
  return saida;
}

/**
 * Cópia do valor com as chaves sensíveis mascaradas e os textos redigidos.
 * Limita profundidade e tamanho para um objeto gigante não virar uma linha de
 * log de megabytes.
 */
export function redigirValor(valor: unknown, profundidade = 0): unknown {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') {
    const texto = valor.length > 4000 ? `${valor.slice(0, 4000)}…` : valor;
    return redigirTexto(texto);
  }
  if (typeof valor !== 'object') return valor;
  if (valor instanceof Date) return valor.toISOString();
  if (valor instanceof Error) {
    return { name: valor.name, message: redigirTexto(valor.message) };
  }
  if (profundidade >= 5) return '[objeto]';

  if (Array.isArray(valor)) {
    const itens = valor
      .slice(0, 50)
      .map((item) => redigirValor(item, profundidade + 1));
    if (valor.length > 50) itens.push(`… +${valor.length - 50}`);
    return itens;
  }

  const saida: Record<string, unknown> = {};
  for (const [chave, item] of Object.entries(
    valor as Record<string, unknown>,
  )) {
    saida[chave] = CHAVES_SENSIVEIS.test(chave)
      ? REDIGIDO
      : redigirValor(item, profundidade + 1);
  }
  return saida;
}
