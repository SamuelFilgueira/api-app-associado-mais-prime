import {
  amostrarPontosPorIntervalo,
  calcularDistanciaMetros,
} from './m7-gps-sanitizer.helper';
import { M7PontoHistoricoRaw } from '../interfaces/m7-historico.interface';

function ponto(segundos: number, extra?: Partial<M7PontoHistoricoRaw>) {
  const data = new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + segundos * 1000);
  return {
    data_gps: data.toISOString().replace('T', ' ').slice(0, 19),
    latitude: -22.9,
    longitude: -43.2,
    ...extra,
  } as M7PontoHistoricoRaw;
}

describe('amostrarPontosPorIntervalo', () => {
  it('mantém o primeiro ponto, os que distam >= intervalo do último mantido e o último', () => {
    const pontos = Array.from({ length: 13 }, (_, i) => ponto(i)); // 0..12 s
    const resultado = amostrarPontosPorIntervalo(pontos, 10);

    expect(resultado.map((p) => p.data_gps)).toEqual([
      pontos[0].data_gps,
      pontos[10].data_gps,
      pontos[12].data_gps,
    ]);
  });

  it('reduz uma sequência de 1 s para aproximadamente 1 ponto a cada 10 s', () => {
    const pontos = Array.from({ length: 600 }, (_, i) => ponto(i));
    const resultado = amostrarPontosPorIntervalo(pontos, 10);

    // 0,10,...,590 = 60 pontos + o último (599)
    expect(resultado).toHaveLength(61);
    expect(resultado[resultado.length - 1]).toBe(pontos[599]);
  });

  it('preserva a ordem original e não duplica pontos', () => {
    const pontos = [ponto(0), ponto(3), ponto(11), ponto(15), ponto(30)];
    const resultado = amostrarPontosPorIntervalo(pontos, 10);

    expect(resultado).toEqual([pontos[0], pontos[2], pontos[4]]);
  });

  it('devolve a lista original quando o intervalo é 0 ou inválido', () => {
    const pontos = [ponto(0), ponto(1), ponto(2)];
    expect(amostrarPontosPorIntervalo(pontos, 0)).toBe(pontos);
    expect(amostrarPontosPorIntervalo(pontos, Number.NaN)).toBe(pontos);
  });

  it('mantém pontos sem data_gps parseável', () => {
    const semData = {
      latitude: -22.9,
      longitude: -43.2,
    } as M7PontoHistoricoRaw;
    const pontos = [ponto(0), ponto(1), semData, ponto(2), ponto(20)];
    const resultado = amostrarPontosPorIntervalo(pontos, 10);

    expect(resultado).toEqual([pontos[0], semData, pontos[4]]);
  });

  it('não altera listas com até dois pontos', () => {
    const pontos = [ponto(0), ponto(1)];
    expect(amostrarPontosPorIntervalo(pontos, 10)).toBe(pontos);
  });
});

describe('calcularDistanciaMetros', () => {
  it('calcula ~111 m para 0,001° de latitude', () => {
    const d = calcularDistanciaMetros(-22.9, -43.2, -22.901, -43.2);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it('retorna 0 para o mesmo ponto', () => {
    expect(calcularDistanciaMetros(-22.9, -43.2, -22.9, -43.2)).toBe(0);
  });
});
