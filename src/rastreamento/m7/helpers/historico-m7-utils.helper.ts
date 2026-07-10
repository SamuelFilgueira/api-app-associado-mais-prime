import { BadRequestException } from '@nestjs/common';
import {
  DiaM7ResumoDto,
  ViagemM7Dto,
} from '../dto/historico-m7-response.dto';
import {
  M7PontoHistoricoRaw,
  M7TrajetoRaw,
} from '../interfaces/m7-historico.interface';

export type M7BuscaPeriodoOptions = {
  expandirDataFinal?: boolean;
  filtrarPeriodoSelecionado?: boolean;
};

export function truncarEndereco(endereco: string): string {
  if (!endereco) return endereco;
  const marker = 'Rio de Janeiro';
  const idx = endereco.indexOf(marker);
  if (idx === -1) return endereco;
  return endereco
    .slice(0, idx + marker.length)
    .replace(/,\s*$/, '')
    .trim();
}

export function formatarEnderecoM7(endereco: string): string {
  if (!endereco?.trim()) return '';
  let s = endereco.trim();
  s = s.replace(/,\s*Braz?il\.?\s*$/i, '').trim();
  s = s.replace(/,\s*\d{5}-\d{3}\s*$/, '').trim();
  s = s.replace(/\s*-\s*[A-Z]{2}\s*$/, '').trim();
  s = s.replace(/[,-]\s*$/, '').trim();
  return truncarEndereco(s);
}

export function isEnderecoValido(
  endereco: string | null | undefined,
): boolean {
  const valor = (endereco ?? '').trim();
  return valor.length > 0 && valor !== '—';
}

export function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const [ano, mes, dia] = isoDate.split('-').map(Number);
  if (!ano || !mes || !dia) return isoDate;

  const date = new Date(ano, mes - 1, dia);
  date.setDate(date.getDate() + deltaDays);

  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toDateTimeParam(date: string): string {
  return `${date} 00:00:00`;
}

export function obterUltimoParadoComDestino(
  rawList: M7TrajetoRaw[],
): string | null {
  for (let i = rawList.length - 1; i >= 0; i--) {
    const item = rawList[i];
    if (item.tipo !== 'PARADO') continue;
    const destino = formatarEnderecoM7(String(item.destino ?? ''));
    if (isEnderecoValido(destino)) {
      return destino;
    }
  }

  return null;
}

export function obterPrimeiroParadoComDestino(
  rawList: M7TrajetoRaw[],
): string | null {
  for (const item of rawList) {
    if (item.tipo !== 'PARADO') continue;
    const destino = formatarEnderecoM7(String(item.destino ?? ''));
    if (isEnderecoValido(destino)) {
      return destino;
    }
  }

  return null;
}

export function complementarDiasParaPdf(
  dias: DiaM7ResumoDto[],
  origemReferenciaAnterior: string | null,
  origemReferenciaPosterior: string | null,
  destinoReferenciaPosterior: string | null,
  destinoReferenciaAnterior: string | null,
): DiaM7ResumoDto[] {
  return dias.map((dia) => ({
    ...dia,
    viagens: dia.viagens.map((viagem) => {
      const origemAtual = (viagem.origem ?? '').trim();
      const destinoAtual = (viagem.destino ?? '').trim();

      let origemFinal = origemAtual;
      let destinoFinal = destinoAtual;

      if (!isEnderecoValido(origemAtual)) {
        if (origemReferenciaAnterior) {
          origemFinal = `${origemReferenciaAnterior} (ref. última parada anterior)`;
        } else if (origemReferenciaPosterior) {
          origemFinal = `${origemReferenciaPosterior} (ref. última parada posterior)`;
        } else {
          origemFinal = 'Referência de origem não encontrada';
        }
      }

      if (!isEnderecoValido(destinoAtual)) {
        const baseOrigem = origemFinal
          .replace(/\s*\(ref[^)]*\)\s*$/i, '')
          .trim();

        const candidatoPos = destinoReferenciaPosterior ?? '';
        const candidatoAnt = destinoReferenciaAnterior ?? '';

        if (candidatoPos && candidatoPos !== baseOrigem) {
          destinoFinal = `${candidatoPos} (ref. última parada posterior)`;
        } else if (candidatoAnt && candidatoAnt !== baseOrigem) {
          destinoFinal = `${candidatoAnt} (ref. última parada anterior)`;
        } else {
          destinoFinal = '—';
        }
      }

      return {
        ...viagem,
        origem: origemFinal,
        destino: destinoFinal,
      };
    }),
  }));
}

function extrairDataIso(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length < 10) return null;
  const data = valor.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null;
}

function dataDentroDoPeriodo(
  dataIso: string,
  dataInicial: string,
  dataFinal: string,
): boolean {
  return dataIso >= dataInicial && dataIso <= dataFinal;
}

export function filtrarTrajetosPorPeriodo(
  trajetos: M7TrajetoRaw[],
  dataInicial: string,
  dataFinal: string,
): M7TrajetoRaw[] {
  return trajetos.filter((trajeto) => {
    const dataInicio = extrairDataIso(trajeto.data_inicio);
    const dataFim = extrairDataIso(trajeto.data_fim);
    const dataBase = dataInicio ?? dataFim;

    if (!dataBase) return true;
    return dataDentroDoPeriodo(dataBase, dataInicial, dataFinal);
  });
}

export function filtrarHistoricoPorPeriodo(
  historico: M7PontoHistoricoRaw[],
  dataInicial: string,
  dataFinal: string,
): M7PontoHistoricoRaw[] {
  return historico.filter((ponto) => {
    const dataGps = extrairDataIso(ponto.data_gps);
    if (!dataGps) return true;
    return dataDentroDoPeriodo(dataGps, dataInicial, dataFinal);
  });
}

export function validarPeriodoMaximoContestacao(
  dataInicial: string,
  dataFinal: string,
): void {
  const inicio = new Date(dataInicial);
  const fim = new Date(dataFinal);

  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    throw new BadRequestException('Período inválido');
  }

  if (fim.getTime() < inicio.getTime()) {
    throw new BadRequestException(
      'dataFinal deve ser maior ou igual a dataInicial',
    );
  }

  const diffMs = fim.getTime() - inicio.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 5) {
    throw new BadRequestException('O período máximo permitido é de 5 dias');
  }
}

export function agruparViagensPorDia(
  viagens: ViagemM7Dto[],
): DiaM7ResumoDto[] {
  const porData = new Map<string, DiaM7ResumoDto>();
  for (const viagem of viagens) {
    const data = viagem.saida.slice(0, 10);
    if (!porData.has(data)) {
      porData.set(data, { data, viagens: [], distanciaTotalKm: 0 });
    }
    const dia = porData.get(data)!;
    dia.viagens.push(viagem);
    dia.distanciaTotalKm =
      Math.round((dia.distanciaTotalKm + viagem.distanciaKm) * 100) / 100;
  }

  return Array.from(porData.values()).sort((a, b) =>
    a.data.localeCompare(b.data),
  );
}