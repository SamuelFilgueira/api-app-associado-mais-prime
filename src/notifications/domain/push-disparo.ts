import { createHash } from 'crypto';
import type { ResultadoPush } from 'src/integrations/expo/push.gateway';

/**
 * Motivo com que o provedor avisa que o aparelho não existe mais (o token
 * pode ser apagado). Mesma regra de `tokenMorto`, da porta de push — repetida
 * aqui porque o domínio só importa TIPOS de fora.
 */
const DETALHE_DE_TOKEN_MORTO = 'DeviceNotRegistered';

/**
 * Regras do disparo de push em massa (marketing e planilha de CPFs).
 *
 * Um disparo (`PushDisparo`) tem uma entrega (`PushEntrega`) por
 * destinatário. O envio roda em lotes de páginas FIXAS de entregas (as
 * mesmas a cada nova tentativa), e cada entrega muda de estado pelo próprio
 * resultado. Lote repetido só manda o que ainda está aberto.
 */
export type TipoDeDisparo = 'MARKETING' | 'SITUACAO_CADASTRO';
export type EstadoDoDisparo = 'CRIADO' | 'ENVIANDO' | 'CONCLUIDO' | 'FALHOU';
export type EstadoDaEntrega =
  | 'PENDENTE'
  | 'ENVIADA'
  | 'ENTREGUE'
  | 'RECUSADA'
  | 'FALHA';

/** Uma página = uma chamada ao provedor (o Expo aceita 100 por requisição). */
export const ENTREGAS_POR_LOTE = 100;
/**
 * Quantas vezes uma entrega com falha de transporte volta a ser tentada.
 * Passou disso, fica em `FALHA` e o disparo fecha sem ela.
 */
export const MAX_TENTATIVAS_DA_ENTREGA = 8;
/** Disparo sem batimento há mais que isto é retomado pela varredura. */
export const DISPARO_PARADO_MS = 15 * 60_000;
/**
 * Disparo que não terminou neste prazo é fechado como está: campanha fora de
 * hora é pior que campanha incompleta.
 */
export const DISPARO_VALIDADE_MS = 6 * 60 * 60_000;
/**
 * Disparo idêntico criado há menos que isto (ou ainda em andamento) é
 * devolvido no lugar de um novo: é o duplo clique do painel.
 */
export const JANELA_DE_REPETICAO_MS = 2 * 60_000;
/** O Expo leva alguns minutos para ter o recibo de entrega. */
export const RECIBOS_ATRASO_MS = 15 * 60_000;
/** Passadas de consulta de recibo por disparo (15 min, 45 min, 1h45). */
export const RECIBOS_MAX_PASSADAS = 3;
export const ENTREGAS_POR_CONSULTA_DE_RECIBO = 300;

export const JOB_PUSH_LOTE = 'push-lote';
export const JOB_PUSH_RECIBOS = 'push-recibos';

export const ERRO_DISPARO_EXPIRADO = 'Disparo expirado antes do envio';

export interface Destinatario {
  userId: number;
  expoPushToken: string;
}

export interface EntregaParaEnvio extends Destinatario {
  id: number;
}

/** Faixa de ids de entrega que um job de lote atende. */
export interface PaginaDeEntregas {
  deId: number;
  ateId: number;
}

export interface LoteJobData extends PaginaDeEntregas {
  disparoId: number;
}

export interface RecibosJobData {
  disparoId: number;
  passada: number;
}

/**
 * Id do job do lote: o mesmo disparo e a mesma página nunca entram duas
 * vezes na fila. A retomada pela varredura leva um sufixo próprio, porque o
 * job original pode ainda estar guardado no Redis como concluído ou falho.
 */
export function jobIdDoLote(
  disparoId: number,
  deId: number,
  retomada?: number,
): string {
  const base = `push-${disparoId}-${deId}`;
  return retomada === undefined ? base : `${base}-r${retomada}`;
}

export function jobIdDosRecibos(disparoId: number, passada: number): string {
  return `push-recibos-${disparoId}-${passada}`;
}

/** Entrega ainda vai ser (re)enviada? */
export function entregaAberta(entrega: {
  estado: string;
  tentativas: number;
}): boolean {
  return (
    entrega.estado === 'PENDENTE' ||
    (entrega.estado === 'FALHA' &&
      entrega.tentativas < MAX_TENTATIVAS_DA_ENTREGA)
  );
}

/**
 * Divide as entregas de um disparo, em ordem de id, em páginas fixas e
 * devolve só as que ainda têm o que enviar. A divisão considera TODAS as
 * entregas (não só as abertas): assim a página de uma retomada é a mesma do
 * job original, e a trava por página impede os dois de enviarem juntos.
 */
export function paginasComPendencia(
  entregas: Array<{ id: number; aberta: boolean }>,
  tamanho: number = ENTREGAS_POR_LOTE,
): PaginaDeEntregas[] {
  const paginas: PaginaDeEntregas[] = [];
  for (let i = 0; i < entregas.length; i += tamanho) {
    const pagina = entregas.slice(i, i + tamanho);
    if (pagina.some((e) => e.aberta)) {
      paginas.push({
        deId: pagina[0].id,
        ateId: pagina[pagina.length - 1].id,
      });
    }
  }
  return paginas;
}

export interface EntregaAceita extends EntregaParaEnvio {
  ticketId: string | null;
}
export interface EntregaRecusada extends EntregaParaEnvio {
  erro: string;
  tokenMorto: boolean;
}
export interface EntregaComFalha extends EntregaParaEnvio {
  erro: string;
}

export interface ResultadoDoLote {
  /** O provedor aceitou: vira `ENVIADA` e ganha a linha da caixa de entrada. */
  aceitas: EntregaAceita[];
  /** O provedor respondeu que não entrega: `RECUSADA`, não se repete. */
  recusadas: EntregaRecusada[];
  /** Não houve resposta: `FALHA`, a única que volta a ser tentada. */
  falhas: EntregaComFalha[];
}

/** Casa cada entrega com o resultado da sua mensagem (mesma posição). */
export function classificarResultados(
  entregas: EntregaParaEnvio[],
  resultados: ResultadoPush[],
): ResultadoDoLote {
  const lote: ResultadoDoLote = { aceitas: [], recusadas: [], falhas: [] };

  entregas.forEach((entrega, i) => {
    const resultado = resultados[i];
    if (!resultado) {
      lote.falhas.push({ ...entrega, erro: 'Sem resultado do provedor' });
    } else if (resultado.status === 'ok') {
      lote.aceitas.push({ ...entrega, ticketId: resultado.ticketId ?? null });
    } else if (resultado.status === 'recusado') {
      lote.recusadas.push({
        ...entrega,
        erro: resumirErro(
          [resultado.detalhe, resultado.mensagem].filter(Boolean).join(': '),
        ),
        tokenMorto: resultado.detalhe === DETALHE_DE_TOKEN_MORTO,
      });
    } else {
      lote.falhas.push({ ...entrega, erro: resumirErro(resultado.mensagem) });
    }
  });
  return lote;
}

export interface ContagemDoDisparo {
  total: number;
  enviadas: number;
  recusadas: number;
  falhas: number;
}

/** Converte a contagem por estado da entrega na contagem do disparo. */
export function contagemDoDisparo(
  porEstado: Partial<Record<EstadoDaEntrega, number>>,
): ContagemDoDisparo {
  const n = (estado: EstadoDaEntrega) => porEstado[estado] ?? 0;
  const enviadas = n('ENVIADA') + n('ENTREGUE');
  const recusadas = n('RECUSADA');
  // No fechamento não sobra `PENDENTE`; se sobrar (disparo expirado), conta
  // como falha: não foi enviada.
  const falhas = n('FALHA') + n('PENDENTE');
  return {
    total: enviadas + recusadas + falhas,
    enviadas,
    recusadas,
    falhas,
  };
}

export interface DesfechoDoDisparo {
  estado: Extract<EstadoDoDisparo, 'CONCLUIDO' | 'FALHOU'>;
  /** Status do `MarketingNotificationAuditLog` (o que o painel mostra). */
  statusDoLog: 'SENT' | 'FAILED';
  erro: string | null;
}

/**
 * Como o disparo termina. Sem destinatários é sucesso com zero (como sempre
 * foi). Com destinatários e nenhum push aceito, é falha.
 */
export function desfechoDoDisparo(c: ContagemDoDisparo): DesfechoDoDisparo {
  if (c.total > 0 && c.enviadas === 0) {
    return {
      estado: 'FALHOU',
      statusDoLog: 'FAILED',
      erro: `Nenhum push aceito: ${c.recusadas} recusado(s) e ${c.falhas} com falha de envio.`,
    };
  }
  return { estado: 'CONCLUIDO', statusDoLog: 'SENT', erro: null };
}

export interface ConteudoDoDisparo {
  tipo: TipoDeDisparo;
  titulo: string;
  corpo: string;
  dados: unknown;
  /** Só na planilha: listas diferentes com o mesmo texto são disparos distintos. */
  userIds?: number[];
}

/**
 * Impressão digital do conteúdo: dois pedidos com a mesma chave são o MESMO
 * disparo (duplo clique, reenvio depois de timeout).
 */
export function chaveDeConteudo(conteudo: ConteudoDoDisparo): string {
  return createHash('sha256')
    .update(
      serializarEstavel({
        tipo: conteudo.tipo,
        titulo: conteudo.titulo,
        corpo: conteudo.corpo,
        dados: conteudo.dados ?? null,
        userIds: conteudo.userIds
          ? [...conteudo.userIds].sort((a, b) => a - b)
          : null,
      }),
    )
    .digest('hex');
}

/** JSON com as chaves em ordem: a ordem dos campos não muda o resultado. */
export function serializarEstavel(valor: unknown): string {
  if (valor === null || valor === undefined) return 'null';
  if (Array.isArray(valor)) {
    return `[${valor.map(serializarEstavel).join(',')}]`;
  }
  if (typeof valor === 'object') {
    const objeto = valor as Record<string, unknown>;
    return `{${Object.keys(objeto)
      .filter((k) => objeto[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${serializarEstavel(objeto[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

/** Mensagem de erro no tamanho da coluna (`PushEntrega.erro`). */
export function resumirErro(mensagem: string | undefined, max = 255): string {
  const texto = (mensagem ?? '').trim() || 'Erro não informado';
  return texto.length > max ? texto.slice(0, max) : texto;
}

/**
 * As entregas de um disparo existente batem com a lista pedida? Disparo
 * ainda em criação pode ter só parte das entregas gravadas: aí basta que as
 * existentes estejam todas na lista.
 */
export function mesmosDestinatarios(
  existentes: number[],
  pedidos: number[],
  emCriacao: boolean,
): boolean {
  const lista = new Set(pedidos);
  if (!emCriacao && new Set(existentes).size !== lista.size) return false;
  return existentes.every((userId) => lista.has(userId));
}

/** Espera entre as passadas de recibo: 15 min, 30 min, 60 min. */
export function atrasoDosRecibos(passada: number): number {
  return RECIBOS_ATRASO_MS * 2 ** Math.max(0, passada - 1);
}
