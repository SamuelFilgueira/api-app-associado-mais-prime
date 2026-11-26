import type { ReinspectionHinovaEnvioStatus } from '@prisma/client';

/** Situação que a Hinova devolve para a foto gravada. */
export const SITUACAO_INSERIDO = 'Inserido';
/** Limite do corpo de resposta persistido no log. */
export const RESPONSE_BODY_MAX_CHARS = 8_000;
export const ERRO_MAX_CHARS = 500;

export const CODIGO_ENVIO_EM_ANDAMENTO = 'REVISTORIA_HINOVA_ENVIO_EM_ANDAMENTO';

export interface FotoParaEnvio {
  id: number;
  nomeArquivo: string;
  codigoTipo: number | null;
  url: string | null;
  sentToHinova: boolean;
}

export interface ResultadoEnvioFoto {
  photoId: number;
  nomeArquivo: string;
  inserida: boolean;
  situacao: string | null;
  erro: string | null;
}

export interface RetornoHinovaFoto {
  nome_arquivo?: string;
  situacao?: string;
}

export type SelecaoDeFotos =
  | { ok: true; fotos: FotoParaEnvio[] }
  /** Algum `photoId` informado não pertence à revistoria. */
  | { ok: false };

/**
 * Fotos que entram no envio: as ainda não inseridas na Hinova (ou todas, com
 * `forcar`), opcionalmente restritas a `photoIds`.
 */
export function selecionarFotos(
  fotos: FotoParaEnvio[],
  opcoes: { photoIds?: number[]; forcar?: boolean },
): SelecaoDeFotos {
  let candidatas = fotos;
  if (opcoes.photoIds && opcoes.photoIds.length > 0) {
    const ids = new Set(opcoes.photoIds);
    candidatas = fotos.filter((f) => ids.has(f.id));
    if (candidatas.length !== ids.size) return { ok: false };
  }
  return {
    ok: true,
    fotos: opcoes.forcar
      ? candidatas
      : candidatas.filter((f) => !f.sentToHinova),
  };
}

export function resultadosIniciais(
  fotos: FotoParaEnvio[],
): Map<number, ResultadoEnvioFoto> {
  return new Map(
    fotos.map((foto) => [
      foto.id,
      {
        photoId: foto.id,
        nomeArquivo: foto.nomeArquivo,
        inserida: false,
        situacao: null,
        erro: null,
      },
    ]),
  );
}

/**
 * Casa o retorno da Hinova (`[{ nome_arquivo, situacao }]`) com as fotos
 * enviadas. Nomes repetidos são atribuídos na ordem de envio. Só a situação
 * `Inserido` marca a foto como enviada — nunca a ausência de erro.
 */
export function aplicarRetorno(
  enviadas: Array<{ id: number; nomeArquivo: string }>,
  retorno: RetornoHinovaFoto[],
  resultados: Map<number, ResultadoEnvioFoto>,
): void {
  const filaPorNome = new Map<string, number[]>();
  for (const foto of enviadas) {
    const fila = filaPorNome.get(foto.nomeArquivo) ?? [];
    fila.push(foto.id);
    filaPorNome.set(foto.nomeArquivo, fila);
  }

  for (const item of retorno) {
    const nome = item?.nome_arquivo;
    if (!nome) continue;
    const photoId = filaPorNome.get(nome)?.shift();
    if (photoId == null) continue;

    const situacao = item.situacao != null ? String(item.situacao) : null;
    const resultado = resultados.get(photoId)!;
    resultado.situacao = situacao;
    resultado.inserida = situacao === SITUACAO_INSERIDO;
    resultado.erro = resultado.inserida
      ? null
      : `Hinova não inseriu a foto (situacao: ${situacao ?? 'vazia'})`;
  }

  for (const foto of enviadas) {
    const resultado = resultados.get(foto.id)!;
    if (!resultado.inserida && resultado.situacao == null) {
      resultado.erro = 'Hinova não retornou resultado para esta foto';
    }
  }
}

/**
 * Status de um conjunto de fotos: vale para a tentativa (fotos do lote) e
 * para o consolidado da revistoria (todas as fotos).
 */
export function statusDoEnvio(
  total: number,
  inseridas: number,
): ReinspectionHinovaEnvioStatus {
  if (total > 0 && inseridas === total) return 'ENVIADA';
  return inseridas > 0 ? 'PARCIAL' : 'FALHA';
}

export function truncar(
  valor: string | null | undefined,
  max: number,
): string | null {
  if (valor == null) return null;
  return valor.length > max ? valor.slice(0, max) : valor;
}

export function mensagemDoErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export function textoDaResposta(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return Object.prototype.toString.call(data);
  }
}

/** Resposta da Hinova sem binários, limitada para caber no log. */
export function resumirResposta(
  data: unknown,
):
  | Array<{ nome_arquivo: string | null; situacao: string | null }>
  | { raw: string | null } {
  if (Array.isArray(data)) {
    return data.slice(0, 200).map((item: RetornoHinovaFoto) => ({
      nome_arquivo: item?.nome_arquivo ?? null,
      situacao: item?.situacao ?? null,
    }));
  }
  return { raw: truncar(textoDaResposta(data), RESPONSE_BODY_MAX_CHARS) };
}

const CODIGOS_DE_REDE_INCERTOS = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ERR_NETWORK',
]);

/**
 * A chamada falhou DEPOIS de possivelmente ter chegado à Hinova (timeout,
 * conexão derrubada)? Nesses casos a foto pode ter sido gravada lá mesmo sem
 * confirmação.
 */
export function falhaComResultadoIncerto(erro: unknown): boolean {
  const e = erro as { tipo?: unknown; code?: unknown; message?: unknown };
  if (typeof e?.tipo === 'string') {
    return e.tipo === 'timeout' || e.tipo === 'indisponivel';
  }
  if (typeof e?.code === 'string' && CODIGOS_DE_REDE_INCERTOS.has(e.code)) {
    return true;
  }
  return (
    typeof e?.message === 'string' && /timeout|socket hang up/i.test(e.message)
  );
}

const AVISO_INCERTO =
  'resultado indeterminado: as fotos podem ter sido gravadas no SGA; confira antes de reenviar';

/** Mensagem persistida quando a chamada lança (rede, timeout, login). */
export function descreverFalhaDaChamada(erro: unknown): string {
  const prefixo = falhaComResultadoIncerto(erro)
    ? `Falha na chamada à Hinova (${AVISO_INCERTO})`
    : 'Falha na chamada à Hinova';
  return truncar(`${prefixo}: ${mensagemDoErro(erro)}`, ERRO_MAX_CHARS)!;
}

/** Mensagem persistida quando a Hinova responde erro ou corpo inesperado. */
export function descreverRespostaInvalida(
  status: number,
  data: unknown,
): string {
  const prefixo =
    status >= 500
      ? `Hinova respondeu HTTP ${status} (${AVISO_INCERTO})`
      : `Hinova respondeu HTTP ${status}`;
  return truncar(`${prefixo}: ${textoDaResposta(data)}`, ERRO_MAX_CHARS)!;
}
