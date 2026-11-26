import { Semaforo } from 'src/shared/semaforo';

const tick = () => new Promise((r) => setImmediate(r));

describe('Semaforo', () => {
  it('nunca passa do máximo e atende a espera em ordem de chegada', async () => {
    const semaforo = new Semaforo(2);
    const liberar: Array<() => void> = [];
    const ordem: number[] = [];
    let emCurso = 0;
    let pico = 0;

    const tarefas = Array.from({ length: 6 }, (_, i) =>
      semaforo.executar(async () => {
        emCurso += 1;
        pico = Math.max(pico, emCurso);
        ordem.push(i);
        await new Promise<void>((r) => liberar.push(r));
        emCurso -= 1;
      }),
    );
    await tick();
    expect(semaforo.estado()).toEqual({ emUso: 2, naEspera: 4 });

    while (liberar.length > 0) {
      liberar.shift()!();
      await tick();
    }
    await Promise.all(tarefas);

    expect(pico).toBe(2);
    expect(ordem).toEqual([0, 1, 2, 3, 4, 5]);
    expect(semaforo.estado()).toEqual({ emUso: 0, naEspera: 0 });
  });

  it('erro na tarefa devolve a vaga', async () => {
    const semaforo = new Semaforo(1);

    await expect(
      semaforo.executar(() => Promise.reject(new Error('falhou'))),
    ).rejects.toThrow('falhou');
    await expect(semaforo.executar(() => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });

  it('recusa máximo inválido', () => {
    expect(() => new Semaforo(0)).toThrow();
    expect(() => new Semaforo(1.5)).toThrow();
  });
});
