import { Queue } from 'bullmq';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/filas';
import {
  INTERVALO_BASE_MS,
  JOB_ID_PREFIXO_VERIFICACAO,
  JOB_VERIFICAR_BOLETO,
} from 'src/sga/config/boleto-verificacao.config';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { BoletoVerificacaoLegadoService } from 'src/sga/services/boleto-verificacao-legado.service';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';
import {
  describeComRedis,
  limparChaves,
  opcoesDoRedisDeTeste,
  redisDeTeste,
} from './ambiente';

const DIA = 86_400_000;
const PREFIXO = `it-pollers-${process.pid}`;

/**
 * Limpeza de boot dos jobs repetíveis ANTIGOS de verificação de boleto,
 * contra o BullMQ instalado e um Redis real. O que está em jogo é o formato
 * do que `getJobSchedulers` devolve: a limpeza anterior dependia de
 * `poller.id`, que esta versão do BullMQ não devolve — então nunca removia
 * nada.
 */
describeComRedis('BullMQ real — pollers antigos de boleto', () => {
  let fila: Queue;
  let pagamentos: { buscarPorNossoNumero: jest.Mock; encerrar: jest.Mock };
  let servico: BoletoVerificacaoLegadoService;

  /** Cria o repetível exatamente como o código antigo criava. */
  const criarPollerAntigo = (nossoNumero: string, endDate: number) =>
    fila.add(
      JOB_VERIFICAR_BOLETO,
      {
        userVehicleId: 7,
        nosso_numero: Number(nossoNumero),
        codigo_veiculo: '55',
        baseOrigin: 'MAIS_PRIME',
      },
      {
        repeat: { every: INTERVALO_BASE_MS, endDate },
        jobId: `${JOB_ID_PREFIXO_VERIFICACAO}${nossoNumero}`,
      },
    );

  const linha = (extra: Record<string, unknown> = {}) => ({
    boletoCriadoEm: new Date(Date.now() - DIA),
    proximaConsultaEm: null,
    verificacaoEncerradaEm: null,
    ...extra,
  });

  beforeAll(() => {
    fila = new Queue(BOLETO_VERIFICACAO_QUEUE, {
      connection: opcoesDoRedisDeTeste(),
      prefix: PREFIXO,
    });
  });

  afterAll(async () => {
    await fila.close();
    const redis = redisDeTeste();
    await limparChaves(redis, `${PREFIXO}:`);
    await redis.quit();
  });

  beforeEach(async () => {
    const redis = redisDeTeste();
    await limparChaves(redis, `${PREFIXO}:`);
    await redis.quit();

    pagamentos = {
      buscarPorNossoNumero: jest.fn().mockResolvedValue(linha()),
      encerrar: jest.fn().mockResolvedValue(true),
    };
    servico = new BoletoVerificacaoLegadoService(
      pagamentos as unknown as PagamentoBoletoRepository,
      {} as VerificarPagamentoBoletoService,
      fila,
    );
  });

  it('o BullMQ instalado NÃO devolve o jobId do repetível: o nosso_numero vem do próximo job agendado', async () => {
    await criarPollerAntigo('111', Date.now() + 30 * DIA);

    const [agendador] = await fila.getJobSchedulers();

    expect(agendador.name).toBe(JOB_VERIFICAR_BOLETO);
    // A chave é um hash e o `id` não vem: `poller.id?.startsWith(...)` era
    // sempre falso e a limpeza antiga pulava todos os pollers.
    expect(agendador.id ?? null).toBeNull();
    expect(agendador.key).not.toContain(':');

    const proximo = await fila.getJob(
      `repeat:${agendador.key}:${agendador.next}`,
    );
    expect(proximo?.data).toMatchObject({ nosso_numero: 111 });
  });

  it('remove o poller de boleto além da idade máxima e mantém o recente', async () => {
    await criarPollerAntigo('111', Date.now() + 30 * DIA);
    await criarPollerAntigo('222', Date.now() + 30 * DIA + 1);
    pagamentos.buscarPorNossoNumero.mockImplementation((nn: string) =>
      Promise.resolve(
        nn === '111'
          ? linha({ boletoCriadoEm: new Date(Date.now() - 40 * DIA) })
          : linha(),
      ),
    );

    const resultado = await servico.limparPollers();

    expect(resultado).toEqual({ ativos: 1, removidos: 1 });
    const restantes = await fila.getJobSchedulers();
    expect(restantes).toHaveLength(1);
    const proximo = await fila.getJob(
      `repeat:${restantes[0].key}:${restantes[0].next}`,
    );
    expect(proximo?.data).toMatchObject({ nosso_numero: 222 });
    // O job já agendado do poller removido sai junto: não sobra disparo.
    expect(await fila.getDelayedCount()).toBe(1);
  });

  it('o mesmo boleto com dois repetíveis (endDate na chave): fica só um', async () => {
    await criarPollerAntigo('333', Date.now() + 30 * DIA);
    await criarPollerAntigo('333', Date.now() + 30 * DIA + 5_000);
    expect(await fila.getJobSchedulers()).toHaveLength(2);

    const resultado = await servico.limparPollers();

    expect(resultado).toEqual({ ativos: 1, removidos: 1 });
    expect(await fila.getJobSchedulers()).toHaveLength(1);
    expect(await fila.getDelayedCount()).toBe(1);
  });

  it('remove o poller de boleto já encerrado ou que passou para a varredura', async () => {
    await criarPollerAntigo('444', Date.now() + 30 * DIA);
    await criarPollerAntigo('555', Date.now() + 30 * DIA + 1);
    await criarPollerAntigo('666', Date.now() + 30 * DIA + 2);
    pagamentos.buscarPorNossoNumero.mockImplementation((nn: string) =>
      Promise.resolve(
        nn === '444'
          ? linha({ verificacaoEncerradaEm: new Date() })
          : nn === '555'
            ? linha({ proximaConsultaEm: new Date() })
            : linha(),
      ),
    );

    const resultado = await servico.limparPollers();

    expect(resultado).toEqual({ ativos: 1, removidos: 2 });
  });

  it('boleto sem linha no banco: o poller fica (o job antigo cria a linha no primeiro disparo)', async () => {
    await criarPollerAntigo('777', Date.now() + 30 * DIA);
    pagamentos.buscarPorNossoNumero.mockResolvedValue(null);

    expect(await servico.limparPollers()).toEqual({ ativos: 1, removidos: 0 });
  });

  it('não toca agendadores de outros jobs da fila (a própria varredura)', async () => {
    await fila.upsertJobScheduler(
      'boleto-verificacao-varredura',
      { every: 60_000 },
      { name: 'varrer-boletos' },
    );
    await criarPollerAntigo('888', Date.now() + 30 * DIA);
    pagamentos.buscarPorNossoNumero.mockResolvedValue(
      linha({ verificacaoEncerradaEm: new Date() }),
    );

    expect(await servico.limparPollers()).toEqual({ ativos: 0, removidos: 1 });
    const restantes = await fila.getJobSchedulers();
    expect(restantes.map((a) => a.name)).toEqual(['varrer-boletos']);
  });
});
