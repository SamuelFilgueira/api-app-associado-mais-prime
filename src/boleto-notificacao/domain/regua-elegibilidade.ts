import { formatDateISO, parseDateSga } from 'src/shared/date.util';
import { SituacaoBoletoSga } from 'src/boleto-notificacao/enums/situacao-boleto-sga.enum';
import {
  normalizarCpf,
  selecionarMaisRecentePorPlaca,
} from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';
import { SgaBoletoPeriodo } from 'src/boleto-notificacao/interfaces/sga-boleto-periodo.interface';
import {
  IntervaloDeDatas,
  vencimentoNaJanela,
} from 'src/boleto-notificacao/domain/regua-janelas';
import { ehFalhaDeTransporte } from 'src/boleto-notificacao/domain/regua-envio';
import {
  ModeloDeMensagem,
  TipoMensagem,
} from 'src/boleto-notificacao/domain/regua-tipos';
import { textosDoGrupo } from 'src/boleto-notificacao/domain/regua-mensagens';

/**
 * Tempo mínimo que um log `ENFILEIRADO` sem ticket precisa ter para ser
 * tratado como órfão (o processo caiu entre gravar e enviar). Abaixo disso a
 * linha pode ser de uma execução viva, prestes a enviar: o envio reserva e
 * despacha em lotes de 100, então uma linha legítima fica nesse estado por
 * segundos — 5 min é folga larga, e fica abaixo do primeiro retry da fila.
 */
export const IDADE_MINIMA_DO_ORFAO_MS = 5 * 60_000;

/** `codigo_situacao_boleto` do SGA para boleto em aberto. */
const SITUACAO_ABERTO: string = SituacaoBoletoSga.ABERTO;

/** 1 push por associado × vencimento efetivo. */
export interface GrupoAssociado {
  codigoAssociado: number;
  cpf: string;
  /** Vencimento efetivo dos boletos do grupo (chave da idempotência). */
  vencimento: Date;
  boletos: SgaBoletoPeriodo[];
}

/** Linha de `BoletoNotificacaoLog` já gravada para um grupo. */
export interface LogExistente {
  id: number;
  codigoAssociado: number;
  dataVencimentoOriginal: Date;
  statusEnvio?: string | null;
  expoTicketId?: string | null;
  expoErro?: string | null;
  atualizadoEm?: Date | null;
}

export interface UsuarioDoApp {
  id: number;
  cpf: string;
  baseOrigin: string | null;
  expoPushToken: string | null;
}

export interface Destinatario extends GrupoAssociado {
  userId: number;
  expoPushToken: string;
  titulo: string;
  corpo: string;
  /** Log de um envio que não se completou; o reenvio reaproveita a linha. */
  logParaRetomar?: LogExistente;
}

/**
 * - `definitivo`: já enviado/entregue, ou recusado pelo Expo. Não reenvia.
 * - `reenviavel`: o envio não se completou (órfão ou falha de transporte).
 * - `em_envio`: `ENFILEIRADO` recente — pode ser de uma execução viva.
 */
export type SituacaoDoLog = 'definitivo' | 'reenviavel' | 'em_envio';

/**
 * Decide se um log existente ainda vale como "já notificado".
 *
 * Só volta a ser elegível o que comprovadamente NÃO chegou ao Expo: linha
 * `ENFILEIRADO` sem ticket e antiga, ou `FALHA` de transporte (sem ticket,
 * `expoErro` de envio). Qualquer estado não reconhecido conta como
 * definitivo — na dúvida, não reenvia.
 */
export function situacaoDoLog(
  log: LogExistente,
  agora: Date,
  idadeMinimaDoOrfaoMs: number = IDADE_MINIMA_DO_ORFAO_MS,
): SituacaoDoLog {
  if (log.expoTicketId) return 'definitivo';

  if (log.statusEnvio === 'FALHA') {
    return ehFalhaDeTransporte(log.expoErro) ? 'reenviavel' : 'definitivo';
  }

  if (log.statusEnvio === 'ENFILEIRADO') {
    if (!(log.atualizadoEm instanceof Date)) return 'em_envio';
    const idade = agora.getTime() - log.atualizadoEm.getTime();
    return idade >= idadeMinimaDoOrfaoMs ? 'reenviavel' : 'em_envio';
  }

  return 'definitivo';
}

/**
 * Filtros da consulta única da base: situação ABERTO, tipo de boleto
 * permitido e a regra "havendo mais de um boleto em aberto do mesmo tipo
 * para a mesma placa, vale só o mais recente".
 */
export function prepararBoletos(
  boletos: SgaBoletoPeriodo[],
  codigosTipoBoleto: string[],
): { prontos: SgaBoletoPeriodo[]; descartados: SgaBoletoPeriodo[] } {
  const abertosDoTipo = boletos.filter(
    (b) =>
      !!parseDateSga(b.dataVencimento) &&
      b.codigoSituacaoBoleto === SITUACAO_ABERTO &&
      (codigosTipoBoleto.length === 0 ||
        codigosTipoBoleto.includes(b.codigoTipoBoleto)),
  );
  const { mantidos, descartados } =
    selecionarMaisRecentePorPlaca(abertosDoTipo);
  return { prontos: mantidos, descartados };
}

/** Boletos cujo vencimento efetivo cai na janela. */
export function boletosNaJanela(
  boletos: SgaBoletoPeriodo[],
  janela: IntervaloDeDatas,
): SgaBoletoPeriodo[] {
  return boletos.filter((b) =>
    vencimentoNaJanela(parseDateSga(b.dataVencimento), janela),
  );
}

/**
 * Elegíveis da etapa: janela + (D+6/D+20) filtro de contrato suspenso.
 * Situação, tipo e "mais recente por placa" já vêm de `prepararBoletos`.
 */
export function elegiveisDaEtapa(
  prontos: SgaBoletoPeriodo[],
  janela: IntervaloDeDatas,
  tipo: TipoMensagem,
  situacoesContratoSuspenso: string[],
): SgaBoletoPeriodo[] {
  const filtroSuspenso =
    tipo === 'D6' || tipo === 'D20'
      ? situacoesContratoSuspenso.map((s) => s.toUpperCase())
      : [];
  return boletosNaJanela(prontos, janela).filter(
    (b) =>
      filtroSuspenso.length === 0 ||
      b.veiculos.some((v) =>
        filtroSuspenso.includes(
          String(v.situacao_veiculo ?? '')
            .trim()
            .toUpperCase(),
        ),
      ),
  );
}

/** Agrupa por associado × vencimento efetivo (1 push por grupo). */
export function agruparPorAssociado(elegiveis: SgaBoletoPeriodo[]): {
  grupos: GrupoAssociado[];
  semIdentificacao: number;
} {
  const grupos = new Map<string, GrupoAssociado>();
  let semIdentificacao = 0;
  for (const boleto of elegiveis) {
    const cpf = normalizarCpf(boleto.cpf);
    const vencimento = parseDateSga(boleto.dataVencimento);
    if (boleto.codigoAssociado === null || !cpf || !vencimento) {
      semIdentificacao++;
      continue;
    }
    const chave = `${boleto.codigoAssociado}:${formatDateISO(vencimento)}`;
    const grupo = grupos.get(chave);
    if (grupo) {
      grupo.boletos.push(boleto);
    } else {
      grupos.set(chave, {
        codigoAssociado: boleto.codigoAssociado,
        cpf,
        vencimento,
        boletos: [boleto],
      });
    }
  }
  return { grupos: Array.from(grupos.values()), semIdentificacao };
}

/**
 * Usuários do app que pertencem à base (ou ainda sem base no cadastro),
 * indexados por CPF. Quem é de outra base fica de fora.
 */
export function usuariosDaBase(
  usuarios: UsuarioDoApp[],
  tenant: string,
): { porCpf: Map<string, UsuarioDoApp>; deOutraBase: number } {
  const porCpf = new Map<string, UsuarioDoApp>();
  let deOutraBase = 0;
  for (const usuario of usuarios) {
    if (usuario.baseOrigin && usuario.baseOrigin !== tenant) {
      deOutraBase++;
      continue;
    }
    porCpf.set(usuario.cpf, usuario);
  }
  return { porCpf, deOutraBase };
}

export interface Selecao {
  destinatarios: Destinatario[];
  /** Já notificados (inclui os `emEnvio`). */
  idempotentes: number;
  semUsuario: number;
  semToken: number;
  duplicadosUsuario: number;
  /** `ENFILEIRADO` recente de outra execução: ninguém confirmou o envio. */
  emEnvio: number;
}

/**
 * Classifica os grupos e monta os destinatários da etapa. Ordem das regras:
 * já notificado → sem usuário no app → sem token válido → mesmo usuário já
 * no lote para o mesmo vencimento.
 */
export function selecionarDestinatarios(entrada: {
  grupos: GrupoAssociado[];
  usuarioPorCpf: Map<string, UsuarioDoApp>;
  logs: LogExistente[];
  tokenValido: (token: unknown) => boolean;
  modelo: ModeloDeMensagem;
  agora: Date;
  idadeMinimaDoOrfaoMs?: number;
}): Selecao {
  const logPorGrupo = new Map(
    entrada.logs.map((log) => [
      `${log.codigoAssociado}:${log.dataVencimentoOriginal.toISOString().slice(0, 10)}`,
      log,
    ]),
  );
  const selecao: Selecao = {
    destinatarios: [],
    idempotentes: 0,
    semUsuario: 0,
    semToken: 0,
    duplicadosUsuario: 0,
    emEnvio: 0,
  };
  const usuariosNoLote = new Set<string>();

  for (const grupo of entrada.grupos) {
    const vencimentoISO = formatDateISO(grupo.vencimento);
    const log = logPorGrupo.get(`${grupo.codigoAssociado}:${vencimentoISO}`);
    const situacao = log
      ? situacaoDoLog(log, entrada.agora, entrada.idadeMinimaDoOrfaoMs)
      : null;
    if (situacao === 'definitivo' || situacao === 'em_envio') {
      selecao.idempotentes++;
      if (situacao === 'em_envio') selecao.emEnvio++;
      continue;
    }

    const usuario = entrada.usuarioPorCpf.get(grupo.cpf);
    if (!usuario) {
      selecao.semUsuario++;
      continue;
    }
    if (!usuario.expoPushToken || !entrada.tokenValido(usuario.expoPushToken)) {
      selecao.semToken++;
      continue;
    }
    const chaveUsuario = `${usuario.id}:${vencimentoISO}`;
    if (usuariosNoLote.has(chaveUsuario)) {
      selecao.duplicadosUsuario++;
      continue;
    }
    usuariosNoLote.add(chaveUsuario);

    selecao.destinatarios.push({
      ...grupo,
      userId: usuario.id,
      expoPushToken: usuario.expoPushToken,
      ...textosDoGrupo(grupo, entrada.modelo),
      ...(log ? { logParaRetomar: log } : {}),
    });
  }

  return selecao;
}
