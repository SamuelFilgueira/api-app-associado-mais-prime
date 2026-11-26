import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import { ComandosVeiculoService } from 'src/rastreamento/services/comandos-veiculo.service';
import { TEST_DATABASE_URL, TEST_REDIS_URL, redisDeTeste } from './ambiente';

const MARCA = `it-rastr-cmd-${process.pid}`;
const PID = String(process.pid).padStart(8, '0');
const CARRO_A = `ITCA${PID}00001`;
const CARRO_B = `ITCB${PID}00001`;
const descreverComBancoERedis =
  TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Âncora e alerta de ignição por veículo contra o banco e o Redis REAIS:
 * a transação com `FOR UPDATE`, as escritas condicionais e a trava por
 * chassi.
 */
descreverComBancoERedis(
  'Banco e Redis reais — âncora e ignição por veículo',
  () => {
    let prisma: PrismaService;
    let redis: Redis;
    let veiculos: VeiculoRastreamentoRepository;
    let comandos: ComandosVeiculoService;
    let userId: number;
    /** Chamadas à "M7": o que foi enviado e quantas estavam em andamento. */
    let chamadas: Array<{ chassi: string; ancora: boolean; ignicao: boolean }>;
    let emAndamento: number;
    let maximoEmAndamento: number;

    const respostaOk = {
      mensagem: 'ok',
      monitorado: 10,
      ancora_ativa: 1,
      evt_ign: 1,
      evg_ign_exec: 0,
      ancora_lat: -22.9,
      ancora_lng: -43.2,
    };

    const chamarM7 = async (
      chassi: string,
      ancora: boolean,
      ignicao: boolean,
    ) => {
      emAndamento += 1;
      maximoEmAndamento = Math.max(maximoEmAndamento, emAndamento);
      chamadas.push({ chassi, ancora, ignicao });
      await dormir(150);
      emAndamento -= 1;
      return respostaOk;
    };

    const veiculo = (chassi: string) =>
      prisma.userVehicle.findFirstOrThrow({ where: { userId, chassi } });
    const usuario = () =>
      prisma.user.findUniqueOrThrow({ where: { id: userId } });

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = new PrismaService();
      await prisma.$connect();
      redis = redisDeTeste();
      veiculos = new VeiculoRastreamentoRepository(prisma);

      const criado = await prisma.user.create({
        data: {
          name: MARCA,
          cpf: `6${String(process.pid).padStart(10, '0')}`.slice(0, 11),
          email: `${MARCA}@teste.local`,
          passwordHash: 'x',
          baseOrigin: 'MAIS_PRIME',
        },
      });
      userId = criado.id;

      comandos = new ComandosVeiculoService(
        veiculos,
        {
          ancoraM7: (
            _cnpj: string,
            chassi: string,
            ancora: boolean,
            ignicao: boolean,
          ) => chamarM7(chassi, ancora, ignicao),
          ignicaoM7: (
            _cnpj: string,
            chassi: string,
            ignicao: boolean,
            ancora: boolean,
          ) => chamarM7(chassi, ancora, ignicao),
        } as unknown as RastreamentoM7,
        new TravaService(redis),
      );
    });

    afterAll(async () => {
      await prisma.veiculoComandoLog.deleteMany({
        where: { chassi: { in: [CARRO_A, CARRO_B] } },
      });
      await prisma.user
        .delete({ where: { id: userId } })
        .catch(() => undefined);
      await prisma.$disconnect();
      await redis.quit();
    });

    beforeEach(async () => {
      chamadas = [];
      emAndamento = 0;
      maximoEmAndamento = 0;
      await prisma.veiculoComandoLog.deleteMany({
        where: { chassi: { in: [CARRO_A, CARRO_B] } },
      });
      await prisma.userVehicle.deleteMany({ where: { userId } });
      await prisma.user.update({
        where: { id: userId },
        data: { ancoraAtiva: false, notificacaoIgnicao: false },
      });
      await prisma.userVehicle.createMany({
        data: [
          { userId, chassi: CARRO_A },
          { userId, chassi: CARRO_B },
        ],
      });
    });

    it('ligar a âncora no A não liga no B; o usuário guarda o agregado; a auditoria é gravada', async () => {
      await comandos.ancora('cnpj', CARRO_A, true, 'MAIS_PRIME', { userId });

      expect(await veiculo(CARRO_A)).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: false,
      });
      // O B recebeu o valor que já valia para ele (o antigo do usuário).
      expect(await veiculo(CARRO_B)).toMatchObject({
        ancoraAtiva: false,
        notificacaoIgnicao: false,
      });
      expect(await usuario()).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: false,
      });
      await expect(
        comandos.statusDaAncora(CARRO_B, { userId }),
      ).resolves.toEqual({ ancoraAtiva: false, userId });

      const logs = await prisma.veiculoComandoLog.findMany({
        where: { chassi: CARRO_A },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        userId,
        userVehicleId: (await veiculo(CARRO_A)).id,
        baseOrigin: 'MAIS_PRIME',
        comando: 'ANCORA',
        valor: true,
        resultado: 'OK',
        erro: null,
      });
    });

    it('veículo ainda null lê o valor do usuário (compatibilidade)', async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { ancoraAtiva: true },
      });

      await expect(
        comandos.statusDaAncora(CARRO_A, { userId }),
      ).resolves.toEqual({ ancoraAtiva: true, userId });
    });

    it('dois comandos simultâneos no MESMO veículo rodam um de cada vez e nenhum desfaz o outro', async () => {
      await Promise.all([
        comandos.ancora('cnpj', CARRO_A, true, 'MAIS_PRIME', { userId }),
        comandos.ignicao('cnpj', CARRO_A, true, 'MAIS_PRIME', { userId }),
      ]);

      expect(maximoEmAndamento).toBe(1);
      // O segundo comando leu o estado gravado pelo primeiro: a última
      // chamada à M7 leva os DOIS ligados.
      expect(chamadas[1]).toEqual({
        chassi: CARRO_A,
        ancora: true,
        ignicao: true,
      });
      expect(await veiculo(CARRO_A)).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: true,
      });
    });

    it('comandos simultâneos em veículos DIFERENTES do mesmo usuário: estado e agregado corretos', async () => {
      await Promise.all([
        comandos.ignicao('cnpj', CARRO_A, true, 'MAIS_PRIME', { userId }),
        comandos.ancora('cnpj', CARRO_B, true, 'MAIS_PRIME', { userId }),
      ]);

      // Veículos diferentes não esperam um pelo outro.
      expect(maximoEmAndamento).toBe(2);
      expect(await veiculo(CARRO_A)).toMatchObject({
        ancoraAtiva: false,
        notificacaoIgnicao: true,
      });
      expect(await veiculo(CARRO_B)).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: false,
      });
      expect(await usuario()).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: true,
      });
    });

    it('memória do provedor: grava, conta falhas só do provedor gravado e zera', async () => {
      const agora = new Date();

      expect(await veiculos.gravarProvedor(CARRO_A, 'm7', agora)).toBe(1);
      expect(await veiculos.registrarFalhaDoProvedor(CARRO_A, 'm7')).toBe(1);
      expect(await veiculos.registrarFalhaDoProvedor(CARRO_A, 'm7')).toBe(1);
      // Falha de quem não é o provedor gravado não conta.
      expect(await veiculos.registrarFalhaDoProvedor(CARRO_A, 'softruck')).toBe(
        0,
      );

      await expect(veiculos.memoriaDeProvedor(CARRO_A)).resolves.toMatchObject({
        provedor: 'm7',
        falhas: 2,
      });

      expect(await veiculos.zerarFalhasDoProvedor(CARRO_A, 'm7')).toBe(1);
      expect(await veiculos.zerarFalhasDoProvedor(CARRO_A, 'm7')).toBe(0);
      await expect(veiculos.memoriaDeProvedor(CARRO_A)).resolves.toMatchObject({
        provedor: 'm7',
        falhas: 0,
      });
      // Chassi sem vínculo: nada a gravar, sem erro.
      expect(
        await veiculos.gravarProvedor('CHASSI-INEXISTENTE', 'm7', agora),
      ).toBe(0);
      await expect(
        veiculos.memoriaDeProvedor('CHASSI-INEXISTENTE'),
      ).resolves.toBeNull();
    });
  },
);
