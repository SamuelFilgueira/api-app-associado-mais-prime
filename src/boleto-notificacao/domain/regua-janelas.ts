import { addDays, formatDateBR, startOfDay } from 'src/shared/date.util';
import { calcularDataAlvo } from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';
import {
  RegrasDeJanela,
  TIPOS_MENSAGEM,
  TipoMensagem,
} from 'src/boleto-notificacao/domain/regua-tipos';

/** Intervalo de datas (meia-noite local), com as duas pontas incluídas. */
export interface IntervaloDeDatas {
  inicio: Date;
  fim: Date;
}

/** Janela de vencimento efetivo consultada por uma etapa da régua. */
export interface JanelaEtapa extends IntervaloDeDatas {
  descricao: string;
}

function descrever(inicio: Date, fim: Date): string {
  return inicio.getTime() === fim.getTime()
    ? formatDateBR(fim)
    : `${formatDateBR(inicio)} a ${formatDateBR(fim)}`;
}

/**
 * Janela de vencimento efetivo da etapa. Regra global: a etapa é definida
 * pela FAIXA DE ATRASO do boleto (ABERTO + tipo permitido), não apenas pelo
 * dia exato — assim um boleto que "entra atrasado" na régua recebe a
 * mensagem da faixa em que está (uma única vez, via idempotência):
 *   DM5: D-5..D-1 (pré-vencimento; cobre boleto gerado depois de D-5)
 *   D0:  atraso 0 · D1: 1..4 · D5: 5 · D6: 6..(D20-1) · D20: 20..(20+alcance)
 *
 * `dataReferencia` é o "hoje" da rotina; só a parte de data é usada.
 */
export function janelaDaEtapa(
  dataReferencia: Date,
  tipo: TipoMensagem,
  regras: RegrasDeJanela,
): JanelaEtapa {
  const referencia = startOfDay(dataReferencia);
  const { offsets } = regras;

  // atraso maior = vencimento mais antigo → é o INÍCIO da janela de datas
  const faixaAtraso = (deAtraso: number, ateAtraso: number): JanelaEtapa => {
    const inicio = calcularDataAlvo(referencia, Math.max(deAtraso, ateAtraso));
    const fim = calcularDataAlvo(referencia, deAtraso);
    return { inicio, fim, descricao: descrever(inicio, fim) };
  };

  switch (tipo) {
    case 'DM5': {
      const inicio = addDays(referencia, 1);
      const fim = addDays(referencia, offsets.DM5);
      return {
        inicio,
        fim,
        descricao: `${formatDateBR(inicio)} a ${formatDateBR(fim)}`,
      };
    }
    case 'D0':
      return faixaAtraso(0, 0);
    case 'D1':
      return faixaAtraso(offsets.D1, offsets.D5 - 1);
    case 'D5':
      return faixaAtraso(offsets.D5, offsets.D5);
    case 'D6':
      return faixaAtraso(offsets.D6, offsets.D20 - 1);
    case 'D20':
      return faixaAtraso(offsets.D20, offsets.D20 + regras.alcanceD20);
  }
}

/**
 * Janela ampla da consulta única ao SGA por base: do vencimento mais antigo
 * que ainda recebe D+20 até o mais futuro que já recebe D-5.
 */
export function janelaDeConsulta(
  dataReferencia: Date,
  regras: RegrasDeJanela,
): IntervaloDeDatas {
  return {
    inicio: calcularDataAlvo(
      dataReferencia,
      regras.offsets.D20 + regras.alcanceD20,
    ),
    fim: addDays(dataReferencia, regras.offsets.DM5),
  };
}

/** O vencimento (meia-noite local) cai dentro do intervalo? */
export function vencimentoNaJanela(
  vencimento: Date | null,
  janela: IntervaloDeDatas,
): boolean {
  return (
    !!vencimento && vencimento >= janela.inicio && vencimento <= janela.fim
  );
}

/** Janelas de todas as etapas para uma data (apoio ao painel). */
export function simularJanelas(dataReferencia: Date, regras: RegrasDeJanela) {
  return TIPOS_MENSAGEM.map((tipo) => ({
    tipo,
    offset: regras.offsets[tipo],
    dataAlvo: janelaDaEtapa(dataReferencia, tipo, regras).descricao,
    // Régua v2: toda etapa é consultada todos os dias (o vencimento
    // efetivo pode cair em qualquer dia útil)
    gatilho: true,
  }));
}
