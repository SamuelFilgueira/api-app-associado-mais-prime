import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { extrairEventoM7 } from 'src/rastreamento/domain/evento-m7';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { EventoWebhookRepository } from 'src/rastreamento/repositories/evento-webhook.repository';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import {
  EventoEmProcessamentoError,
  ProcessarWebhookM7Service,
} from 'src/rastreamento/services/processar-webhook-m7.service';
import { TEST_DATABASE_URL, TEST_REDIS_URL, redisDeTeste } from './ambiente';

const MARCA = `it-rastr-wh-${process.pid}`;
const CHASSI = `ITWH${String(process.pid).padStart(8, '0')}00001`;
const descreverComBancoERedis =
  TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;

/**
 * Webhook da M7 contra o banco e o Redis REAIS: o índice único de
 * `eventoHash` e a trava do evento são o que garante "uma linha e um push"
 * quando a M7 reentrega — fake de banco não prova isso.
 */
descreverComBancoERedis(
  'Banco e Redis reais — webhook da M7 idempotente',
  () => {
    let prisma: PrismaService;
    let redis: Redis;
    let webhook: ProcessarWebhookM7Service;
    let userId: number;
    const pushes: Array<{ chassi: string; chave: string | undefined }> = [];

    // Fixture sintética, só com a FORMA do payload da M7.
    const evento = (mudancas: Record<string, unknown> = {}) => ({
      codigo: '900001',
      chassi: CHASSI,
      monitorado: '10',
      evento: 'Ignição Ligada',
      tipoevento: 32,
      titulo: 'Alerta',
      canal: { identificacao: 'canal-x', nome: 'Canal X' },
      enviado_em: '2026-08-31T13:00:00.000Z',
      ...mudancas,
    });

    const linhasDoChassi = () =>
      prisma.vehicleWebhookEvent.findMany({
        where: { chassi: CHASSI },
        orderBy: { id: 'asc' },
      });

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = new PrismaService();
      await prisma.$connect();
      redis = redisDeTeste();

      const usuario = await prisma.user.create({
        data: {
          name: MARCA,
          cpf: `7${String(process.pid).padStart(10, '0')}`.slice(0, 11),
          email: `${MARCA}@teste.local`,
          passwordHash: 'x',
          baseOrigin: 'MAIS_PRIME',
          notificacaoIgnicao: true,
        },
      });
      userId = usuario.id;
      await prisma.userVehicle.create({ data: { userId, chassi: CHASSI } });

      webhook = new ProcessarWebhookM7Service(
        new EventoWebhookRepository(prisma),
        new VeiculoRastreamentoRepository(prisma),
        {
          dispararNotificacaoVeiculoWebhook: (
            chassi: string,
            _tipo: number | null,
            _evento: string | null,
            opcoes?: { chaveDoEvento?: string },
          ) => {
            pushes.push({ chassi, chave: opcoes?.chaveDoEvento });
            return Promise.resolve({ sent: 1, skipped: 0 });
          },
        } as unknown as NotificationsService,
        {
          processarWebhook: (payload: unknown) => ({
            sucesso: true,
            mensagem: 'Webhook processado com sucesso',
            dados: { palyload: payload },
          }),
        } as unknown as RastreamentoM7,
        new TravaService(redis),
      );
    });

    afterAll(async () => {
      await prisma.vehicleWebhookEvent.deleteMany({
        where: { chassi: CHASSI },
      });
      await prisma.user
        .delete({ where: { id: userId } })
        .catch(() => undefined);
      await prisma.$disconnect();
      await redis.quit();
    });

    beforeEach(async () => {
      await prisma.vehicleWebhookEvent.deleteMany({
        where: { chassi: CHASSI },
      });
      pushes.length = 0;
    });

    it('dez entregas simultâneas do mesmo evento: UMA linha e UM push', async () => {
      const resultados = await Promise.allSettled(
        Array.from({ length: 10 }, () => webhook.executar(evento())),
      );

      const processados = resultados.filter(
        (r) => r.status === 'fulfilled' && r.value.resultado === 'processado',
      );
      expect(processados).toHaveLength(1);
      // As demais ou esbarraram na trava (o job tenta de novo) ou já
      // encontraram o evento tratado.
      for (const r of resultados) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(EventoEmProcessamentoError);
        } else {
          expect(['processado', 'duplicado']).toContain(r.value.resultado);
        }
      }

      const linhas = await linhasDoChassi();
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({
        eventoHash: extrairEventoM7(evento()).hash,
        processed: true,
        provider: 'M7',
        tipoevento: 32,
      });
      expect(pushes).toEqual([
        { chassi: CHASSI, chave: extrairEventoM7(evento()).hash },
      ]);

      // A nova tentativa de quem esbarrou na trava termina sem push.
      await expect(webhook.executar(evento())).resolves.toMatchObject({
        resultado: 'duplicado',
      });
      expect(pushes).toHaveLength(1);
    });

    it('o banco recusa a segunda linha com o mesmo hash (P2002)', async () => {
      await webhook.executar(evento());

      await expect(
        prisma.vehicleWebhookEvent.create({
          data: {
            chassi: CHASSI,
            payload: '{}',
            eventoHash: extrairEventoM7(evento()).hash,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('linhas antigas, sem hash, convivem com o índice único', async () => {
      await prisma.vehicleWebhookEvent.createMany({
        data: [
          { chassi: CHASSI, payload: '{}' },
          { chassi: CHASSI, payload: '{}' },
        ],
      });

      await expect(webhook.executar(evento())).resolves.toMatchObject({
        resultado: 'processado',
      });
      expect(await linhasDoChassi()).toHaveLength(3);
    });

    it('evento mais antigo que o último processado é descartado (data lida do payload gravado)', async () => {
      await webhook.executar(
        evento({ codigo: '900002', enviado_em: '2026-08-31T13:10:00.000Z' }),
      );

      const atrasado = await webhook.executar(
        evento({ codigo: '900001', enviado_em: '2026-08-31T13:00:00.000Z' }),
      );
      const seguinte = await webhook.executar(
        evento({ codigo: '900003', enviado_em: '2026-08-31T13:20:00.000Z' }),
      );

      expect(atrasado.resultado).toBe('descartado');
      expect(seguinte.resultado).toBe('processado');
      expect(pushes).toHaveLength(2);
      const linhas = await linhasDoChassi();
      expect(linhas.map((l) => l.processed)).toEqual([true, false, true]);
    });

    it('erro de banco na gravação propaga e nenhum push sai', async () => {
      // `evento` tem limite de 255 caracteres: o banco recusa a linha.
      const invalido = evento({ evento: 'x'.repeat(300) });

      await expect(webhook.executar(invalido)).rejects.toBeDefined();

      expect(pushes).toHaveLength(0);
      expect(await linhasDoChassi()).toHaveLength(0);
    });
  },
);
