import {
  SorteFaixaRaspadinha,
  SorteFase,
  SorteMarcoSequencia,
  SorteMecanica,
  SorteRodadaEstado,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { somarDias } from 'src/associado-sorte/helpers/sorte-data.helper';

/**
 * Regras puras do Associado da Sorte (sem Nest/Prisma), para teste unitário.
 * Toda aleatoriedade entra por parâmetro (`randomInt(maxExclusivo)`), que em
 * produção é o `crypto.randomInt` (ver `SorteAleatorioService`).
 */
export type RandomInt = (maxExclusivo: number) => number;

// ------------------------------------------------------------------ fase

export interface RodadaParaFase {
  estado: SorteRodadaEstado;
  mecanica: SorteMecanica;
  abertura: Date;
  encerramento: Date;
  quantidadeRestante: number;
}

/**
 * Fase exibida no app, calculada pelo relógio do servidor. Não depende do
 * job: um sorteio vencido aparece como APURANDO mesmo antes de o job rodar.
 * Corrida/vitrine sem unidades fica ESGOTADA até o horário de encerramento.
 */
export function calcularFase(rodada: RodadaParaFase, agora: Date): SorteFase {
  const ehSorteio = rodada.mecanica === SorteMecanica.SORTEIO;
  const esgotou = !ehSorteio && rodada.quantidadeRestante <= 0;
  const passouEncerramento = agora.getTime() >= rodada.encerramento.getTime();

  if (
    rodada.estado === SorteRodadaEstado.ENCERRADA ||
    rodada.estado === SorteRodadaEstado.CANCELADA
  ) {
    return esgotou && !passouEncerramento
      ? SorteFase.ESGOTADA
      : SorteFase.ENCERRADA;
  }
  if (rodada.estado === SorteRodadaEstado.APURANDO) return SorteFase.APURANDO;

  if (agora.getTime() < rodada.abertura.getTime()) return SorteFase.EM_BREVE;
  if (passouEncerramento) {
    return ehSorteio ? SorteFase.APURANDO : SorteFase.ENCERRADA;
  }
  return esgotou ? SorteFase.ESGOTADA : SorteFase.ABERTA;
}

// ------------------------------------------------------------- raspadinha

/** MariaDB guarda JSON como texto: aceita o valor já decodificado ou a string. */
function lerLista(json: unknown): unknown[] {
  if (typeof json === 'string') {
    try {
      const decodificado: unknown = JSON.parse(json);
      return Array.isArray(decodificado) ? decodificado : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(json) ? json : [];
}

export function lerFaixas(json: unknown): SorteFaixaRaspadinha[] {
  return lerLista(json)
    .map((f) => ({
      creditos: Number((f as SorteFaixaRaspadinha)?.creditos),
      peso: Number((f as SorteFaixaRaspadinha)?.peso),
    }))
    .filter(
      (f) =>
        Number.isInteger(f.creditos) &&
        f.creditos >= 1 &&
        Number.isInteger(f.peso) &&
        f.peso >= 1,
    );
}

export function lerMarcos(json: unknown): SorteMarcoSequencia[] {
  return lerLista(json)
    .map((m) => ({
      dias: Number((m as SorteMarcoSequencia)?.dias),
      bonus: Number((m as SorteMarcoSequencia)?.bonus),
    }))
    .filter(
      (m) =>
        Number.isInteger(m.dias) &&
        m.dias >= 2 &&
        Number.isInteger(m.bonus) &&
        m.bonus >= 1,
    )
    .sort((a, b) => a.dias - b.dias);
}

/** Mensagem do problema ou `null` quando as faixas são válidas. */
export function validarFaixas(faixas: SorteFaixaRaspadinha[]): string | null {
  if (!Array.isArray(faixas) || faixas.length === 0) {
    return 'Informe ao menos uma faixa da raspadinha';
  }
  const vistos = new Set<number>();
  for (const f of faixas) {
    if (!Number.isInteger(f.creditos) || f.creditos < 1) {
      return 'Cada faixa precisa de créditos inteiros maiores que zero';
    }
    if (!Number.isInteger(f.peso) || f.peso < 1) {
      return 'Cada faixa precisa de peso inteiro maior que zero';
    }
    if (vistos.has(f.creditos)) {
      return `Faixa repetida: ${f.creditos} crédito(s)`;
    }
    vistos.add(f.creditos);
  }
  return null;
}

/** Mensagem do problema ou `null` quando os marcos são válidos. */
export function validarMarcos(marcos: SorteMarcoSequencia[]): string | null {
  const vistos = new Set<number>();
  for (const m of marcos ?? []) {
    if (!Number.isInteger(m.dias) || m.dias < 2) {
      return 'Cada marco precisa de pelo menos 2 dias';
    }
    if (!Number.isInteger(m.bonus) || m.bonus < 1) {
      return 'Cada marco precisa de bônus inteiro maior que zero';
    }
    if (vistos.has(m.dias)) return `Marco repetido: ${m.dias} dias`;
    vistos.add(m.dias);
  }
  return null;
}

/** Sorteia o valor da raspadinha com chance proporcional ao peso da faixa. */
export function sortearFaixa(
  faixas: SorteFaixaRaspadinha[],
  randomInt: RandomInt,
): number {
  const total = faixas.reduce((soma, f) => soma + f.peso, 0);
  if (total <= 0) return 0;
  let ponto = randomInt(total);
  for (const faixa of faixas) {
    if (ponto < faixa.peso) return faixa.creditos;
    ponto -= faixa.peso;
  }
  return faixas[faixas.length - 1].creditos;
}

// --------------------------------------------------------------- sequência

export interface SequenciaCalculada {
  sequencia: number;
  bonus: number;
}

/**
 * Sequência do dia `hoje`: continua se a última coleta foi ontem, senão volta
 * para 1. Depois de coletar no dia do maior marco, recomeça em 1.
 */
export function calcularSequencia(params: {
  hoje: string;
  ultimoDia: string | null;
  sequenciaAnterior: number;
  marcos: SorteMarcoSequencia[];
}): SequenciaCalculada {
  const { hoje, ultimoDia, sequenciaAnterior, marcos } = params;
  const maiorMarco = marcos.reduce((maior, m) => Math.max(maior, m.dias), 0);
  const coletouOntem = ultimoDia !== null && somarDias(ultimoDia, 1) === hoje;
  const fechouCiclo = maiorMarco > 0 && sequenciaAnterior >= maiorMarco;

  const sequencia =
    coletouOntem && !fechouCiclo ? Math.max(0, sequenciaAnterior) + 1 : 1;
  const bonus = marcos.find((m) => m.dias === sequencia)?.bonus ?? 0;
  return { sequencia, bonus };
}

/** Sequência "viva" para exibir (zera se o associado pulou um dia). */
export function sequenciaVigente(params: {
  hoje: string;
  ultimoDia: string | null;
  sequencia: number;
}): number {
  const { hoje, ultimoDia, sequencia } = params;
  if (!ultimoDia) return 0;
  if (ultimoDia === hoje || somarDias(ultimoDia, 1) === hoje) return sequencia;
  return 0;
}

export function proximoMarco(params: {
  hoje: string;
  ultimoDia: string | null;
  sequencia: number;
  marcos: SorteMarcoSequencia[];
}): { dias: number; bonus: number; faltam: number } | null {
  const { marcos } = params;
  if (marcos.length === 0) return null;
  const maiorMarco = marcos[marcos.length - 1].dias;
  let atual = sequenciaVigente(params);
  // Fechou o ciclo: a próxima coleta recomeça em 1.
  if (atual >= maiorMarco) atual = 0;
  const marco = marcos.find((m) => m.dias > atual);
  if (!marco) return null;
  return { dias: marco.dias, bonus: marco.bonus, faltam: marco.dias - atual };
}

// ----------------------------------------------------------------- sorteio

export interface BilhetesDoParticipante {
  userId: number;
  bilhetes: number;
}

/**
 * Sorteia até `quantidade` ganhadores DISTINTOS, com chance proporcional aos
 * bilhetes (amostragem ponderada sem reposição). Com menos participantes que
 * unidades, todos ganham.
 */
export function sortearGanhadores(
  participantes: BilhetesDoParticipante[],
  quantidade: number,
  randomInt: RandomInt,
): number[] {
  const restantes = participantes
    .filter((p) => p.bilhetes > 0)
    .map((p) => ({ ...p }));
  const ganhadores: number[] = [];

  while (ganhadores.length < quantidade && restantes.length > 0) {
    const total = restantes.reduce((soma, p) => soma + p.bilhetes, 0);
    let ponto = randomInt(total);
    let indice = 0;
    for (; indice < restantes.length; indice++) {
      if (ponto < restantes[indice].bilhetes) break;
      ponto -= restantes[indice].bilhetes;
    }
    indice = Math.min(indice, restantes.length - 1);
    ganhadores.push(restantes[indice].userId);
    restantes.splice(indice, 1);
  }
  return ganhadores;
}

// ------------------------------------------------------------------ código

/** Sem 0/O, 1/I/L: o código é lido em voz alta e conferido pela equipe. */
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TAMANHO_CODIGO = 6;

export function gerarCodigo(randomInt: RandomInt): string {
  let codigo = '';
  for (let i = 0; i < TAMANHO_CODIGO; i++) {
    codigo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  }
  return codigo;
}

// ------------------------------------------------------------ apresentação

/** Lista pública: primeiro nome + inicial do sobrenome ("Samuel F."). */
export function nomePublico(nome: string | null | undefined): string {
  const partes = String(nome ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (partes.length === 0) return 'Associado';
  const capitalizar = (p: string) =>
    p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  const primeiro = capitalizar(partes[0]);
  if (partes.length === 1) return primeiro;
  return `${primeiro} ${partes[partes.length - 1].charAt(0).toUpperCase()}.`;
}

/** CPF mascarado para o painel: "***.456.789-**". */
export function mascararCpf(cpf: string | null | undefined): string {
  const digitos = String(cpf ?? '').replace(/\D/g, '');
  if (digitos.length !== 11) return '***.***.***-**';
  return `***.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-**`;
}

/**
 * Normaliza telefone para o formato do wa.me: só dígitos, com DDI 55.
 * Devolve `null` quando não parece um número brasileiro (DDD + 8/9 dígitos).
 */
export function normalizarTelefone(
  valor: string | null | undefined,
): string | null {
  let digitos = (valor ?? '').replace(/\D/g, '');
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  if (!/^55\d{10,11}$/.test(digitos)) return null;
  return digitos;
}

/** Telefone para log: nunca registrar o número completo. */
export function mascararTelefone(telefone: string | null | undefined): string {
  const digitos = String(telefone ?? '').replace(/\D/g, '');
  if (digitos.length < 4) return '****';
  return `****${digitos.slice(-4)}`;
}

/** Link wa.me com mensagem pronta. O link só abre a conversa; não envia nada. */
export function linkWhatsapp(
  telefone: string | null | undefined,
  mensagem: string,
): string | null {
  const numero = normalizarTelefone(telefone);
  if (!numero) return null;
  return `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
}

export function metaPaginacao(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ------------------------------------------------------------ janela aberta

export interface MotivoRodadaFechada {
  code: 'RODADA_NAO_ABERTA' | 'RODADA_ENCERRADA' | 'ESGOTADO';
  message: string;
}

/**
 * Por que a rodada não aceita participação/resgate em `agora`, ou `null` se
 * está aberta. Usada na recusa rápida (leitura simples) e de novo dentro da
 * transação, com a linha travada. Compara sempre com o relógio do servidor.
 */
export function motivoRodadaFechada(
  rodada: RodadaParaFase,
  agora: Date,
): MotivoRodadaFechada | null {
  const esgotada: MotivoRodadaFechada = {
    code: 'ESGOTADO',
    message: 'As unidades desta rodada acabaram',
  };
  const encerrada: MotivoRodadaFechada = {
    code: 'RODADA_ENCERRADA',
    message: 'Esta rodada já foi encerrada',
  };

  if (rodada.estado !== SorteRodadaEstado.PUBLICADA) {
    const esgotou =
      rodada.mecanica !== SorteMecanica.SORTEIO &&
      rodada.quantidadeRestante <= 0;
    return rodada.estado === SorteRodadaEstado.ENCERRADA && esgotou
      ? esgotada
      : encerrada;
  }

  switch (calcularFase(rodada, agora)) {
    case SorteFase.ABERTA:
      return null;
    case SorteFase.EM_BREVE:
      return {
        code: 'RODADA_NAO_ABERTA',
        message: 'Esta rodada ainda não abriu',
      };
    case SorteFase.ESGOTADA:
      return esgotada;
    default:
      return encerrada;
  }
}

/** Limita quantas tarefas assíncronas rodam ao mesmo tempo no processo. */
export class Semaforo {
  private emUso = 0;
  private readonly fila: Array<() => void> = [];

  constructor(private readonly limite: number) {}

  /** Devolve a função que libera a vaga (chamar em `finally`). */
  async adquirir(): Promise<() => void> {
    if (this.emUso >= this.limite) {
      await new Promise<void>((resolve) => this.fila.push(resolve));
    } else {
      this.emUso++;
    }
    let liberado = false;
    return () => {
      if (liberado) return;
      liberado = true;
      const proximo = this.fila.shift();
      // Passa a vaga direto para o próximo da fila (emUso não muda).
      if (proximo) proximo();
      else this.emUso--;
    };
  }
}
