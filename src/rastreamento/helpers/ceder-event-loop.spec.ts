import {
  cederEventLoop,
  percorrerEmBlocos,
} from 'src/rastreamento/helpers/ceder-event-loop';
import {
  sanitizarPontosGps,
  sanitizarPontosGpsEmBlocos,
} from 'src/rastreamento/m7/helpers/m7-gps-sanitizer.helper';
import { M7PontoHistoricoRaw } from 'src/rastreamento/m7/interfaces/m7-historico.interface';

describe('laços longos cedem o event loop', () => {
  it('percorrerEmBlocos processa tudo em ordem e deixa outras tarefas rodarem no meio', async () => {
    const itens = Array.from({ length: 2_500 }, (_, i) => i);
    const vistos: number[] = [];
    let processadosQuandoOutraTarefaRodou = -1;
    setImmediate(() => {
      processadosQuandoOutraTarefaRodou = vistos.length;
    });

    await percorrerEmBlocos(itens, (item) => vistos.push(item), 1_000);

    expect(vistos).toEqual(itens);
    // A outra tarefa rodou ANTES de o laço acabar: o laço cedeu a vez.
    expect(processadosQuandoOutraTarefaRodou).toBeGreaterThan(0);
    expect(processadosQuandoOutraTarefaRodou).toBeLessThan(itens.length);
  });

  it('cederEventLoop resolve depois das tarefas já agendadas', async () => {
    const ordem: string[] = [];
    setImmediate(() => ordem.push('agendada'));

    await cederEventLoop();
    ordem.push('depois');

    expect(ordem).toEqual(['agendada', 'depois']);
  });

  it('histórico de 31 dias: a sanitização em blocos dá o MESMO resultado da direta', async () => {
    // ~45 mil pontos: um a cada minuto, com jitter, lixo e duplicatas no meio.
    const inicio = new Date(2026, 6, 1, 0, 0, 0).getTime();
    const pontos: M7PontoHistoricoRaw[] = [];
    for (let i = 0; i < 31 * 24 * 60; i++) {
      const data = new Date(inicio + i * 60_000);
      const p = (n: number) => String(n).padStart(2, '0');
      pontos.push({
        data_gps: `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())} ${p(data.getHours())}:${p(data.getMinutes())}:00`,
        latitude: i % 97 === 0 ? 0 : -22.9 + (i % 500) * 0.0001,
        longitude: -43.2 - (i % 300) * 0.0001,
        velocidade: i % 80,
        ignicao: i % 3 === 0,
      });
      if (i % 50 === 0) pontos.push({ ...pontos[pontos.length - 1] });
    }

    const emBlocos = await sanitizarPontosGpsEmBlocos(pontos);

    expect(emBlocos).toEqual(sanitizarPontosGps(pontos));
    expect(emBlocos.length).toBeGreaterThan(40_000);
  });
});
