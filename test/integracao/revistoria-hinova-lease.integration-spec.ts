import { ReinspectionHinovaEnvioOrigem } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import {
  FotoParaEnvio,
  ResultadoEnvioFoto,
} from 'src/reinspection/domain/hinova-envio';
import { ReinspectionHinovaRepository } from 'src/reinspection/repositories/reinspection-hinova.repository';
import { ReinspectionHinovaLoteService } from 'src/reinspection/services/reinspection-hinova-lote.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { RevistoriaBancoReal } from 'src/reinspection/testing/revistoria-banco-real';
import { resetTenantConfigCache } from 'src/config/tenant.config';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const APROVACAO = { origem: ReinspectionHinovaEnvioOrigem.APROVACAO };
const MANUAL = { origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL };
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lease do envio de fotos à Hinova contra o MariaDB real: a reivindicação é
 * um `UPDATE` condicional em `Reinspection.hinovaEnvioLeaseAte`.
 *
 * A postagem do lote é um dublê lento que "confirma" todas as fotos; o que
 * está sob teste é a exclusão entre envios e o que fica gravado.
 */
describeComBanco('Banco real — lease do envio de fotos à Hinova', () => {
  let prisma: PrismaService;
  let dados: RevistoriaBancoReal;
  let repositorio: ReinspectionHinovaRepository;
  let service: ReinspectionHinovaService;
  const lote = { postar: jest.fn() };

  const lease = (id: number) =>
    prisma.reinspection
      .findUniqueOrThrow({
        where: { id },
        select: { hinovaEnvioLeaseAte: true },
      })
      .then((r) => r.hinovaEnvioLeaseAte);

  const basesOriginais = process.env.TENANT_BASES;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // Bases fixas para o teste: o Prisma Client recarrega o `.env` da máquina
    // ao ser instanciado, e o tenant local pode ser outro.
    process.env.TENANT_BASES = 'MAIS_PRIME:,MAIS_PRIME_RS:_RS';
    resetTenantConfigCache();
    prisma = new PrismaService();
    await prisma.$connect();
    dados = new RevistoriaBancoReal(prisma);
    repositorio = new ReinspectionHinovaRepository(prisma);
    service = new ReinspectionHinovaService(
      repositorio,
      lote as unknown as ReinspectionHinovaLoteService,
    );
  });

  afterAll(async () => {
    await dados.limpar();
    await prisma.$disconnect();
    if (basesOriginais === undefined) delete process.env.TENANT_BASES;
    else process.env.TENANT_BASES = basesOriginais;
    resetTenantConfigCache();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    lote.postar.mockImplementation(
      async (_revistoria: unknown, _base: string, fotos: FotoParaEnvio[]) => {
        await dormir(60);
        const resultados: ResultadoEnvioFoto[] = fotos.map((foto) => ({
          photoId: foto.id,
          nomeArquivo: foto.nomeArquivo,
          inserida: true,
          situacao: 'Inserido',
          erro: null,
        }));
        return {
          resultados,
          chamada: { httpStatus: 200, errorMessage: null },
        };
      },
    );
  });

  it('8 reivindicações simultâneas: exatamente uma leva o lease', async () => {
    const { reinspectionId } = await dados.revistoria('APROVADA');
    const agora = new Date();

    const leases = await Promise.all(
      Array.from({ length: 8 }, () =>
        repositorio.reivindicarLease(reinspectionId, agora, 60_000),
      ),
    );

    expect(leases.filter((l) => l !== null)).toHaveLength(1);
  });

  it('6 envios simultâneos da mesma revistoria: UM posta, UM registro, cada foto com UMA tentativa', async () => {
    const { reinspectionId, fotoIds } = await dados.revistoria('APROVADA', [
      'APROVADA',
      'APROVADA',
      'APROVADA',
    ]);

    const resultados = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.enviarFotos(reinspectionId, APROVACAO),
      ),
    );

    expect(lote.postar).toHaveBeenCalledTimes(1);
    expect(resultados.filter((r) => r !== null)).toHaveLength(1);
    expect(
      await prisma.reinspectionHinovaEnvio.count({ where: { reinspectionId } }),
    ).toBe(1);
    const fotos = await prisma.reinspectionPhoto.findMany({
      where: { id: { in: fotoIds } },
      select: { sentToHinova: true, hinovaTentativas: true },
    });
    expect(fotos).toEqual(
      fotoIds.map(() => ({ sentToHinova: true, hinovaTentativas: 1 })),
    );
    expect(await lease(reinspectionId)).toBeNull();
  });

  it('reenvio manual durante o envio automático → 409; depois que ele termina, não há mais nada a enviar', async () => {
    const { reinspectionId } = await dados.revistoria('APROVADA', ['APROVADA']);

    const automatico = service.enviarFotos(reinspectionId, APROVACAO);
    await dormir(20);
    await expect(
      service.enviarFotos(reinspectionId, MANUAL),
    ).rejects.toMatchObject({
      code: 'REVISTORIA_HINOVA_ENVIO_EM_ANDAMENTO',
      status: 409,
    });
    await automatico;

    await expect(
      service.enviarFotos(reinspectionId, MANUAL),
    ).resolves.toBeNull();
    expect(lote.postar).toHaveBeenCalledTimes(1);
  });

  it('lease vencido é assumido; lease válido de outro processo é respeitado', async () => {
    const { reinspectionId } = await dados.revistoria('APROVADA', ['APROVADA']);

    await prisma.reinspection.update({
      where: { id: reinspectionId },
      data: { hinovaEnvioLeaseAte: new Date(Date.now() + 60_000) },
    });
    await expect(
      service.enviarFotos(reinspectionId, APROVACAO),
    ).resolves.toBeNull();
    expect(lote.postar).not.toHaveBeenCalled();

    await prisma.reinspection.update({
      where: { id: reinspectionId },
      data: { hinovaEnvioLeaseAte: new Date(Date.now() - 1_000) },
    });
    const resultado = await service.enviarFotos(reinspectionId, APROVACAO);
    expect(resultado?.status).toBe('ENVIADA');
    expect(await lease(reinspectionId)).toBeNull();
  });

  it('soltar só solta o lease desta execução', async () => {
    const { reinspectionId } = await dados.revistoria('APROVADA');
    const antigo = await repositorio.reivindicarLease(
      reinspectionId,
      new Date(Date.now() - 600_000),
      1_000,
    );
    const atual = await repositorio.reivindicarLease(
      reinspectionId,
      new Date(),
      60_000,
    );

    await repositorio.soltarLease(reinspectionId, antigo!);
    expect(await lease(reinspectionId)).toEqual(atual);

    await repositorio.soltarLease(reinspectionId, atual!);
    expect(await lease(reinspectionId)).toBeNull();
  });

  it('falha ao gravar o resultado solta o lease', async () => {
    const { reinspectionId } = await dados.revistoria('APROVADA', ['APROVADA']);
    jest
      .spyOn(repositorio, 'registrarTentativa')
      .mockRejectedValueOnce(new Error('falha simulada'));

    await expect(
      service.enviarFotos(reinspectionId, APROVACAO),
    ).rejects.toThrow('falha simulada');
    expect(await lease(reinspectionId)).toBeNull();
  });

  it('dono do veículo sem base: BaseNaoResolvidaError, sem postar, sem lease e sem registro', async () => {
    const { reinspectionId } = await dados.revistoria(
      'APROVADA',
      ['APROVADA'],
      null,
    );

    await expect(
      service.enviarFotos(reinspectionId, APROVACAO),
    ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

    expect(lote.postar).not.toHaveBeenCalled();
    expect(await lease(reinspectionId)).toBeNull();
    expect(
      await prisma.reinspectionHinovaEnvio.count({ where: { reinspectionId } }),
    ).toBe(0);
  });
});
