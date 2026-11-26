/**
 * Regra pura do estado de âncora e de alerta de ignição.
 *
 * O estado é do VEÍCULO. As colunas do veículo são anuláveis: `null` quer
 * dizer "ainda não definido para este veículo", e aí vale o valor antigo,
 * gravado no usuário.
 */

export interface EstadoDoVeiculo {
  ancoraAtiva: boolean;
  notificacaoIgnicao: boolean;
}

export interface EstadoGravadoNoVeiculo {
  ancoraAtiva: boolean | null;
  notificacaoIgnicao: boolean | null;
}

/** Estado que vale para o veículo: o dele; se `null`, o do usuário. */
export function estadoEfetivo(
  veiculo: EstadoGravadoNoVeiculo,
  usuario: EstadoDoVeiculo,
): EstadoDoVeiculo {
  return {
    ancoraAtiva: veiculo.ancoraAtiva ?? usuario.ancoraAtiva,
    notificacaoIgnicao:
      veiculo.notificacaoIgnicao ?? usuario.notificacaoIgnicao,
  };
}

/**
 * Valor que fica no usuário (coluna antiga, mantida para quem ainda a lê):
 * ligado quando ALGUM veículo dele está ligado.
 *
 * Não pode ser "o último valor gravado": com dois veículos, desligar o alerta
 * do carro B apagaria o do usuário e o push do carro A deixaria de sair.
 */
export function valorAgregadoDoUsuario(
  porVeiculo: readonly boolean[],
): boolean {
  return porVeiculo.some((ligado) => ligado);
}

/**
 * Lê um booleano vindo do app (`true`/`false`, `1`/`0`, como texto ou
 * número). Devolve `null` quando o valor não é reconhecido.
 */
export function lerBooleanoDeEntrada(valor: unknown): boolean | null {
  if (typeof valor === 'boolean') return valor;
  if (valor === 1) return true;
  if (valor === 0) return false;
  if (typeof valor === 'string') {
    const normalizado = valor.trim().toLowerCase();
    if (normalizado === 'true' || normalizado === '1') return true;
    if (normalizado === 'false' || normalizado === '0') return false;
  }
  return null;
}
