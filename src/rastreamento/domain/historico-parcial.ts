/**
 * Histórico montado dia a dia pode ficar incompleto quando a consulta de um
 * dia falha. Antes a resposta saía igual à de um dia sem viagens; agora ela
 * avisa quais dias falharam.
 */

/** Campos ADITIVOS das respostas JSON de histórico. */
export interface AvisoDeHistoricoParcial {
  /** `true` quando a consulta de algum dia falhou: o período pode estar incompleto. */
  parcial: boolean;
  /** Dias (`yyyy-mm-dd`) cuja consulta falhou, em ordem. */
  diasComFalha: string[];
}

/**
 * Uma falha de consulta é diferente de "dia sem viagens": timeout, erro de
 * rede, 5xx, 408 e 429 são falha; 4xx do provedor para o dia (ex.: 404) é
 * dia sem dados.
 */
export function ehFalhaDeConsultaDoDia(
  statusHttp: number | undefined,
): boolean {
  if (statusHttp === undefined) return true;
  if (statusHttp === 408 || statusHttp === 429) return true;
  return statusHttp >= 500;
}

/** Monta o aviso a partir dos dias no formato da Softruck (`YYYYMMDD`). */
export function avisoDeHistoricoParcial(
  accsComFalha: Iterable<number>,
): AvisoDeHistoricoParcial {
  const dias = [...new Set(accsComFalha)]
    .sort((a, b) => a - b)
    .map((acc) => {
      const texto = String(acc);
      return `${texto.slice(0, 4)}-${texto.slice(4, 6)}-${texto.slice(6, 8)}`;
    });
  return { parcial: dias.length > 0, diasComFalha: dias };
}
