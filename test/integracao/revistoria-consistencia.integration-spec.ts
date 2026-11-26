import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { UsuarioAutenticado } from 'src/infra/auth/usuario-autenticado';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { MailService } from 'src/infra/mail/mail.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { ReinspectionVehicleType } from 'src/reinspection/dto/create-reinspection.dto';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { ReinspectionAndamentoService } from 'src/reinspection/services/reinspection-andamento.service';
import { ReinspectionAprovacaoService } from 'src/reinspection/services/reinspection-aprovacao.service';
import { ReinspectionAvaliacaoService } from 'src/reinspection/services/reinspection-avaliacao.service';
import { ReinspectionEnvioService } from 'src/reinspection/services/reinspection-envio.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { ReinspectionSubmissaoService } from 'src/reinspection/services/reinspection-submissao.service';
import { RevistoriaBancoReal } from 'src/reinspection/testing/revistoria-banco-real';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  describeComBanco,
  redisDeTeste,
} from './ambiente';

const PAINEL: UsuarioAutenticado = {
  userId: 1,
  role: 'ADMIN',
  adminRole: 'REVISTORIA',
};
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cumpridas = <T>(resultados: PromiseSettledResult<T>[]) =>
  resultados.filter((r) => r.status === 'fulfilled');
const recusadas = <T>(resultados: PromiseSettledResult<T>[]) =>
  resultados
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map(
      (r) => r.reason as { code?: string; status?: number; message: string },
    );

/**
 * Consistência da revistoria contra o MariaDB real: o que o dublê em memória
 * não reproduz — `UPDATE ... WHERE status IN (...)` concorrente, trava de
 * linha (`SELECT ... FOR UPDATE`), rollback e o índice único da idempotência.
 */
describeComBanco('Banco real — consistência da revistoria', () => {
  let prisma: PrismaService;
  let dados: RevistoriaBancoReal;
  let revistorias: ReinspectionRepository;
  let fotos: ReinspectionPhotoRepository;
  let avaliacao: ReinspectionAvaliacaoService;
  let aprovacao: ReinspectionAprovacaoService;
  let andamento: ReinspectionAndamentoService;

  const boleto = { processar: jest.fn() };
  const hinova = { enviarFotos: jest.fn() };
  const mail = {
    sendRevistoriaEmail: jest.fn(),
    sendFotoRecusadaReenviadaEmail: jest.fn(),
  };
  const upload = {
    uploadReinspectionPhotoFromBase64: jest.fn(),
    buildUrl: jest.fn((caminho?: string | null) => caminho ?? null),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    dados = new RevistoriaBancoReal(prisma);

    revistorias = new ReinspectionRepository(prisma);
    fotos = new ReinspectionPhotoRepository(prisma);
    avaliacao = new ReinspectionAvaliacaoService(revistorias, fotos);
    aprovacao = new ReinspectionAprovacaoService(
      revistorias,
      fotos,
      hinova as unknown as ReinspectionHinovaService,
      boleto as unknown as BoletoReativacaoService,
    );
    andamento = new ReinspectionAndamentoService(
      revistorias,
      fotos,
      upload as unknown as FileUploadService,
      mail as unknown as MailService,
    );
  });

  afterAll(async () => {
    await dados.limpar();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Efeitos lentos: dão tempo de a segunda chamada chegar no meio.
    hinova.enviarFotos.mockImplementation(async () => {
      await dormir(40);
      return null;
    });
    boleto.processar.mockImplementation(async () => {
      await dormir(40);
      return {
        status: 'GERADO',
        nossoNumero: '1',
        tentativas: 1,
        proximaTentativaEm: null,
        erro: null,
      };
    });
    mail.sendRevistoriaEmail.mockImplementation(() => dormir(40));
    mail.sendFotoRecusadaReenviadaEmail.mockResolvedValue(undefined);
    let arquivo = 0;
    upload.uploadReinspectionPhotoFromBase64.mockImplementation(() =>
      Promise.resolve(`uploads/reinspection-photos/it-${++arquivo}.jpg`),
    );
  });

  describe('transicionar', () => {
    it('8 transições simultâneas para o mesmo destino: exatamente uma ganha', async () => {
      const { reinspectionId } = await dados.revistoria('EM_ANALISE');

      const resultados = await Promise.all(
        Array.from({ length: 8 }, () =>
          revistorias.transicionar(
            reinspectionId,
            ['PENDENTE', 'EM_ANALISE'],
            'APROVADA',
            { repeticaoIdempotente: true },
          ),
        ),
      );

      expect(resultados.filter((r) => r.ganhou)).toHaveLength(1);
      expect(await dados.status(reinspectionId)).toBe('APROVADA');
    });

    it('destinos diferentes ao mesmo tempo (aprovar × finalizar): o estado final é um caminho válido da tabela', async () => {
      const { reinspectionId } = await dados.revistoria('EM_ANALISE');

      const [aprovar, finalizar] = await Promise.allSettled([
        revistorias.transicionar(reinspectionId, ['EM_ANALISE'], 'APROVADA'),
        revistorias.transicionar(
          reinspectionId,
          ['PENDENTE', 'EM_ANALISE', 'APROVADA', 'REPROVADA'],
          'FINALIZADA',
        ),
      ]);

      // Finalizar sempre passa (parte de qualquer estado aberto); aprovar só
      // passa se chegou antes — e nunca reabre a FINALIZADA.
      expect(finalizar.status).toBe('fulfilled');
      expect(await dados.status(reinspectionId)).toBe('FINALIZADA');
      if (aprovar.status === 'rejected') {
        expect(aprovar.reason).toMatchObject({
          code: 'REVISTORIA_TRANSICAO_INVALIDA',
          status: 409,
        });
      }
    });
  });

  describe('aprovação', () => {
    it('6 aprovações simultâneas: UM boleto, UM envio à Hinova, todas respondem APROVADA', async () => {
      const { userVehicleId, reinspectionId } = await dados.revistoria(
        'EM_ANALISE',
        ['APROVADA', 'APROVADA'],
      );

      const respostas = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          aprovacao.aprovar(userVehicleId, `it-${i}`, { userId: 1 }),
        ),
      );

      expect(boleto.processar).toHaveBeenCalledTimes(1);
      expect(hinova.enviarFotos).toHaveBeenCalledTimes(1);
      expect(respostas.every((r) => r.status === 'APROVADA')).toBe(true);
      expect(respostas.filter((r) => !r.repetida)).toHaveLength(1);
      expect(await dados.status(reinspectionId)).toBe('APROVADA');
    });

    it('aprovar × reprovar foto, 12 rodadas: nunca termina APROVADA com foto reprovada', async () => {
      for (let rodada = 0; rodada < 12; rodada++) {
        const { userVehicleId, reinspectionId, fotoIds } =
          await dados.revistoria('EM_ANALISE', ['APROVADA', 'PENDENTE']);

        await Promise.allSettled([
          aprovacao.aprovar(userVehicleId),
          avaliacao.reprovarFoto(fotoIds[1]),
        ]);

        const status = await dados.status(reinspectionId);
        const reprovada = await dados.temFotoReprovada(reinspectionId);
        expect(reprovada).toBe(true);
        expect(status).toBe('REPROVADA');
      }
    });
  });

  describe('avaliação de foto (linha da revistoria travada)', () => {
    it('aprovar a única foto reprovada × reprovar outra, 15 rodadas: a revistoria termina REPROVADA', async () => {
      for (let rodada = 0; rodada < 15; rodada++) {
        const { reinspectionId, fotoIds } = await dados.revistoria(
          'REPROVADA',
          ['REPROVADA', 'PENDENTE'],
        );

        const resultados = await Promise.allSettled([
          avaliacao.aprovarFoto(fotoIds[0]),
          avaliacao.reprovarFoto(fotoIds[1]),
        ]);

        expect(recusadas(resultados)).toEqual([]);
        // Sem a trava, a aprovação lia "nenhuma outra reprovada" e gravava
        // EM_ANALISE por cima da reprovação simultânea.
        expect(await dados.temFotoReprovada(reinspectionId)).toBe(true);
        expect(await dados.status(reinspectionId)).toBe('REPROVADA');
      }
    });

    it('o painel aprova todas as fotos em paralelo: todas passam e a revistoria fica EM_ANALISE', async () => {
      const { reinspectionId, fotoIds } = await dados.revistoria(
        'PENDENTE',
        Array.from({ length: 12 }, () => 'PENDENTE' as const),
      );

      const resultados = await Promise.allSettled(
        fotoIds.map((id) => avaliacao.aprovarFoto(id)),
      );

      expect(recusadas(resultados)).toEqual([]);
      expect(await dados.status(reinspectionId)).toBe('EM_ANALISE');
      expect(
        await prisma.reinspectionPhoto.count({
          where: { reinspectionId, status: 'APROVADA' },
        }),
      ).toBe(12);
    });

    it('aprovar fotos em paralelo DEPOIS da aprovação não rebaixa a revistoria', async () => {
      const { reinspectionId, fotoIds } = await dados.revistoria('APROVADA', [
        'PENDENTE',
        'PENDENTE',
        'PENDENTE',
      ]);

      await Promise.all(fotoIds.map((id) => avaliacao.aprovarFoto(id)));

      expect(await dados.status(reinspectionId)).toBe('APROVADA');
    });

    it('reprovar foto de revistoria FINALIZADA → 409 e a foto NÃO muda (rollback real)', async () => {
      const { reinspectionId, fotoIds } = await dados.revistoria('FINALIZADA', [
        'APROVADA',
      ]);

      await expect(avaliacao.reprovarFoto(fotoIds[0])).rejects.toMatchObject({
        code: 'REVISTORIA_TRANSICAO_INVALIDA',
        status: 409,
      });

      expect(await dados.status(reinspectionId)).toBe('FINALIZADA');
      expect(await dados.temFotoReprovada(reinspectionId)).toBe(false);
    });
  });

  describe('reenvio de foto (app)', () => {
    it('reenvio em dobro da mesma foto: um troca e avisa; o outro recebe 400', async () => {
      const { reinspectionId, fotoIds } = await dados.revistoria('REPROVADA', [
        'REPROVADA',
      ]);

      const resultados = await Promise.allSettled([
        andamento.reenviarFoto(fotoIds[0], 'QUJD', PAINEL),
        andamento.reenviarFoto(fotoIds[0], 'QUJD', PAINEL),
      ]);

      expect(cumpridas(resultados)).toHaveLength(1);
      expect(recusadas(resultados).map((e) => e.message)).toEqual([
        'Somente fotos reprovadas podem ser reenviadas',
      ]);
      expect(mail.sendFotoRecusadaReenviadaEmail).toHaveBeenCalledTimes(1);
      expect(await dados.status(reinspectionId)).toBe('EM_ANALISE');
    });

    it('revistoria APROVADA com foto reprovada (dado antigo): 409 e a foto fica como estava', async () => {
      const { fotoIds } = await dados.revistoria('APROVADA', ['REPROVADA']);
      const antes = await prisma.reinspectionPhoto.findUniqueOrThrow({
        where: { id: fotoIds[0] },
      });

      await expect(
        andamento.reenviarFoto(fotoIds[0], 'QUJD', PAINEL),
      ).rejects.toMatchObject({ code: 'REVISTORIA_TRANSICAO_INVALIDA' });

      const depois = await prisma.reinspectionPhoto.findUniqueOrThrow({
        where: { id: fotoIds[0] },
      });
      expect(depois).toMatchObject({ status: 'REPROVADA', url: antes.url });
    });

    it('fotos diferentes reenviadas em paralelo (como o app faz): todas passam', async () => {
      const { reinspectionId, fotoIds } = await dados.revistoria('REPROVADA', [
        'REPROVADA',
        'REPROVADA',
        'REPROVADA',
        'REPROVADA',
      ]);

      const resultados = await Promise.allSettled(
        fotoIds.map((id) => andamento.reenviarFoto(id, 'QUJD', PAINEL)),
      );

      expect(recusadas(resultados)).toEqual([]);
      expect(await dados.status(reinspectionId)).toBe('EM_ANALISE');
      expect(await dados.temFotoReprovada(reinspectionId)).toBe(false);
    });
  });

  describe('submissão (IdempotenciaService real, índice único)', () => {
    it('5 submits simultâneos: UM e-mail e todos respondem 200', async () => {
      const { reinspectionId } = await dados.revistoria('PENDENTE', [
        'PENDENTE',
      ]);
      const submissao = new ReinspectionSubmissaoService(
        revistorias,
        mail as unknown as MailService,
        new IdempotenciaService(prisma),
      );

      const respostas = await Promise.all(
        Array.from({ length: 5 }, () =>
          submissao.submeter(reinspectionId, PAINEL),
        ),
      );
      const repetida = await submissao.submeter(reinspectionId, PAINEL);

      expect(mail.sendRevistoriaEmail).toHaveBeenCalledTimes(1);
      expect(respostas.filter((r) => r.notificacao === 'ENVIADA')).toHaveLength(
        1,
      );
      expect(repetida.notificacao).toBe('JA_ENVIADA');
      // O submit continua sem mudar o status.
      expect(await dados.status(reinspectionId)).toBe('PENDENTE');
    });

    it('e-mail que falha libera a marca: a nova submissão envia', async () => {
      const { reinspectionId } = await dados.revistoria('PENDENTE', [
        'PENDENTE',
      ]);
      const submissao = new ReinspectionSubmissaoService(
        revistorias,
        mail as unknown as MailService,
        new IdempotenciaService(prisma),
      );
      mail.sendRevistoriaEmail.mockRejectedValueOnce(new Error('smtp fora'));

      const falhou = await submissao.submeter(reinspectionId, PAINEL);
      const depois = await submissao.submeter(reinspectionId, PAINEL);

      expect(falhou.notificacao).toBe('FALHOU');
      expect(depois.notificacao).toBe('ENVIADA');
    });
  });

  (TEST_REDIS_URL ? describe : describe.skip)(
    'criação (TravaService real no Redis)',
    () => {
      let redis: Redis;
      let envio: ReinspectionEnvioService;

      beforeAll(() => {
        redis = redisDeTeste();
        envio = new ReinspectionEnvioService(
          revistorias,
          fotos,
          upload as unknown as FileUploadService,
          new TravaService(redis),
        );
      });

      afterAll(async () => {
        await redis.quit();
      });

      it('8 criações simultâneas para o mesmo veículo: UMA revistoria, mesmo id em todas as respostas', async () => {
        const { userVehicleId } = await dados.veiculo();
        const dto = {
          userVehicleId,
          vehicleType: ReinspectionVehicleType.MOTOS,
          codigoVeiculo: 123,
        };

        const respostas = await Promise.all(
          Array.from({ length: 8 }, () => envio.criar(dto, PAINEL)),
        );

        expect(
          await prisma.reinspection.count({ where: { userVehicleId } }),
        ).toBe(1);
        expect(new Set(respostas.map((r) => r.reinspectionId)).size).toBe(1);
        expect(respostas.every((r) => r.status === 'PENDENTE')).toBe(true);
        expect(
          await redis.keys(`trava:revistoria-criar:${userVehicleId}`),
        ).toEqual([]);
      });

      it('nova tentativa depois de fotos enviadas cria outra revistoria (fluxo do app preservado)', async () => {
        const { userVehicleId, reinspectionId } = await dados.revistoria(
          'PENDENTE',
          ['PENDENTE'],
        );

        const resposta = await envio.criar(
          {
            userVehicleId,
            vehicleType: ReinspectionVehicleType.VEICULOS_LEVES,
          },
          PAINEL,
        );

        expect(resposta.reinspectionId).not.toBe(reinspectionId);
        expect(
          await prisma.reinspection.count({ where: { userVehicleId } }),
        ).toBe(2);
      });
    },
  );
});
