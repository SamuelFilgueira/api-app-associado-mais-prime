/** Erros listados por extenso na mensagem de uma rodada que falhou. */
const MAXIMO_POR_EXTENSO = 5;

/**
 * Junta os erros de uma rodada de varredura numa mensagem de tamanho
 * limitado: com a Hinova fora, todas as linhas da rodada falham pelo mesmo
 * motivo, e listar todas a cada minuto só enche o log.
 */
export function resumirErros(erros: string[]): string {
  const porExtenso = erros.slice(0, MAXIMO_POR_EXTENSO).join('; ');
  const restantes = erros.length - MAXIMO_POR_EXTENSO;
  return restantes > 0 ? `${porExtenso}; e mais ${restantes}` : porExtenso;
}
