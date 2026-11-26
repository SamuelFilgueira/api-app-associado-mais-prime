import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { SorteRaspadasRepository } from 'src/associado-sorte/repositories/sorte-raspadas.repository';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteLembreteRaspadaService } from 'src/associado-sorte/services/sorte-lembrete-raspada.service';
import { configDeTeste } from 'src/associado-sorte/testing/sorte-fixtures';
import { NOTIFICATION_QUEUE, PUSH_MASSA_QUEUE } from 'src/queue/queue.module';

const sp = (texto: string) => new Date(`${texto}:00.000-03:00`);

describe('SorteLembreteRaspadaService', () => {
  let service: SorteLembreteRaspadaService;

  /** Estado do associado: raspadas de hoje e liberação já avisada. */
  let estado: {
    raspadas: Date[];
    lembreteRaspadaEm: Date | null;
  };
  const fila = { addBulk: jest.fn() };
  /** Fila de alerta (ignição, âncora): os lembretes NÃO podem entrar nela. */
  const filaDeAlerta = { add: jest.fn(), addBulk: jest.fn() };
  const config = { obter: jest.fn() };
  const campanhas = { publicadaDaBase: jest.fn() };
  const repository = {
    // Devolve sempre o associado: a decisão fica com o serviço.
    listarCandidatosLembrete: jest.fn((p: { dia: string }) => {
      const hoje = estado.raspadas.filter(
        (r) =>
          new Date(r.getTime() - 3 * 3_600_000).toISOString().slice(0, 10) ===
          p.dia,
      );
      return Promise.resolve([
        {
          userId: 7,
          expoPushToken: 'ExponentPushToken[x]',
          raspadasHoje: hoje.length,
          ultimaRaspadaHojeEm: hoje.length ? hoje[hoje.length - 1] : null,
          lembreteRaspadaEm: estado.lembreteRaspadaEm,
        },
      ]);
    }),
    reivindicarLembrete: jest.fn(
      (_userId: number, _base: string, liberacao: Date) => {
        if (
          estado.lembreteRaspadaEm &&
          estado.lembreteRaspadaEm.getTime() >= liberacao.getTime()
        ) {
          return Promise.resolve(false);
        }
        estado.lembreteRaspadaEm = liberacao;
        return Promise.resolve(true);
      },
    ),
  };

  /** Pushes enfileirados: cada job da fila de massa leva várias mensagens. */
  const pushes = () =>
    fila.addBulk.mock.calls
      .flatMap((c: [Array<{ data: { mensagens: unknown[] } }>]) => c[0])
      .flatMap((job) => job.data.mensagens).length;

  beforeEach(async () => {
    jest.clearAllMocks();
    estado = { raspadas: [], lembreteRaspadaEm: null };
    config.obter.mockResolvedValue(
      configDeTeste({
        raspadasPorDia: 2,
        intervaloMinimoMinutos: 60,
        lembretesAtivos: true,
        lembreteInicio: '08:00',
        lembreteFim: '21:00',
      }),
    );
    campanhas.publicadaDaBase.mockResolvedValue({
      id: 1,
      inicio: sp('2026-11-01T00:00'),
      fim: sp('2026-12-31T23:59'),
    });
    fila.addBulk.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        SorteLembreteRaspadaService,
        { provide: SorteConfigService, useValue: config },
        { provide: SorteCampanhaService, useValue: campanhas },
        { provide: SorteRaspadasRepository, useValue: repository },
        { provide: getQueueToken(PUSH_MASSA_QUEUE), useValue: fila },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: filaDeAlerta },
      ],
    }).compile();
    service = module.get(SorteLembreteRaspadaService);
  });

  it('nada fora da janela; a liberação da 00:00 é avisada uma vez quando a janela abre', async () => {
    expect(await service.enviar(sp('2026-11-20T00:30'))).toBe(0);
    expect(await service.enviar(sp('2026-11-20T07:59'))).toBe(0);

    expect(await service.enviar(sp('2026-11-20T08:00'))).toBe(1);
    expect(await service.enviar(sp('2026-11-20T08:00'))).toBe(0);
    expect(await service.enviar(sp('2026-11-20T12:00'))).toBe(0);
    expect(pushes()).toBe(1);
    // Vai para a fila de MASSA, num job em lote; a fila de alerta fica livre.
    expect(filaDeAlerta.add).not.toHaveBeenCalled();
    expect(filaDeAlerta.addBulk).not.toHaveBeenCalled();
    const job = fila.addBulk.mock.calls[0][0][0];
    expect(job).toMatchObject({
      name: 'sorte-lembrete-raspada',
      data: {
        mensagens: [
          {
            userId: 7,
            expoPushToken: 'ExponentPushToken[x]',
            data: { type: 'internal_route', screen: 'associado-da-sorte' },
          },
        ],
        // Envelope do job: base da campanha e metadados de rastreio.
        baseOrigin: 'MAIS_PRIME',
        _meta: { v: 1, criadoEm: expect.any(String) },
      },
    });
    // Sem opções no job: vale o retry padrão da fila de massa.
    expect(job.opts).toBeUndefined();
  });

  it('250 lembretes no mesmo ciclo: três jobs de até 100 mensagens na fila de massa', async () => {
    repository.listarCandidatosLembrete.mockResolvedValueOnce(
      Array.from({ length: 250 }, (_, i) => ({
        userId: i + 1,
        expoPushToken: `ExponentPushToken[u${i + 1}]`,
        raspadasHoje: 0,
        ultimaRaspadaHojeEm: null,
        lembreteRaspadaEm: null,
      })),
    );
    // `Once`: a implementação com estado continua valendo nos outros casos.
    for (let i = 0; i < 250; i++) {
      repository.reivindicarLembrete.mockResolvedValueOnce(true);
    }

    expect(await service.enviar(sp('2026-11-20T08:00'))).toBe(250);

    const jobs = fila.addBulk.mock.calls[0][0] as Array<{
      name: string;
      data: { mensagens: Array<{ userId: number }> };
    }>;
    expect(jobs.map((j) => j.data.mensagens.length)).toEqual([100, 100, 50]);
    expect(jobs.every((j) => j.name === 'sorte-lembrete-raspada')).toBe(true);
    expect(jobs[2].data.mensagens[49].userId).toBe(250);
    expect(filaDeAlerta.addBulk).not.toHaveBeenCalled();
  });

  it('nova liberação depois do intervalo gera um novo aviso, uma vez', async () => {
    await service.enviar(sp('2026-11-20T08:00'));
    estado.raspadas.push(sp('2026-11-20T09:00'));

    // Antes de cumprir o intervalo: nada.
    expect(await service.enviar(sp('2026-11-20T09:59'))).toBe(0);
    expect(await service.enviar(sp('2026-11-20T10:00'))).toBe(1);
    expect(await service.enviar(sp('2026-11-20T10:05'))).toBe(0);

    // Sem raspada restante no dia: nada.
    estado.raspadas.push(sp('2026-11-20T10:10'));
    expect(await service.enviar(sp('2026-11-20T15:00'))).toBe(0);
    expect(pushes()).toBe(2);
  });

  it('liberação fora da janela espera o início da próxima, sem acumular', async () => {
    estado.raspadas.push(sp('2026-11-20T20:30'));
    // Libera às 21:30, já fora da janela: nada à noite.
    expect(await service.enviar(sp('2026-11-20T21:30'))).toBe(0);
    expect(await service.enviar(sp('2026-11-20T23:59'))).toBe(0);
    // No dia seguinte, um único aviso (o da 00:00) quando a janela abre.
    expect(await service.enviar(sp('2026-11-21T08:00'))).toBe(1);
    expect(await service.enviar(sp('2026-11-21T08:01'))).toBe(0);
    expect(pushes()).toBe(1);
  });

  it('lembretes desligados ou sem campanha no período: nada', async () => {
    config.obter.mockResolvedValue(configDeTeste({ lembretesAtivos: false }));
    expect(await service.enviar(sp('2026-11-20T10:00'))).toBe(0);
    config.obter.mockResolvedValue(configDeTeste());
    campanhas.publicadaDaBase.mockResolvedValue(null);
    expect(await service.enviar(sp('2026-11-20T10:00'))).toBe(0);
    expect(fila.addBulk).not.toHaveBeenCalled();
  });
});
