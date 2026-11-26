import { promises as fs } from 'fs';
import { ReinspectionHinovaEnvioOrigem } from '@prisma/client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { ReinspectionHinovaRepository } from 'src/reinspection/repositories/reinspection-hinova.repository';
import { ReinspectionHinovaLoteService } from 'src/reinspection/services/reinspection-hinova-lote.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { PrismaRevistoriaMemoria } from 'src/reinspection/testing/prisma-revistoria.memoria';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    promises: { ...real.promises, readFile: jest.fn() },
  };
});

const APROVACAO = { origem: ReinspectionHinovaEnvioOrigem.APROVACAO };
const MANUAL = { origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL };

/** Promessa que o teste resolve quando quiser (a Hinova "demorando"). */
function adiada<T>() {
  let resolver!: (valor: T) => void;
  const promessa = new Promise<T>((r) => (resolver = r));
  return { promessa, resolver };
}

const inserido = (nome: string) => ({
  status: 200,
  data: [{ nome_arquivo: nome, situacao: 'Inserido' }],
});

/**
 * Lease do envio de fotos à Hinova (`Reinspection.hinovaEnvioLeaseAte`) e
 * resolução da base do associado.
 */
describe('ReinspectionHinovaService — lease e base', () => {
  let banco: PrismaRevistoriaMemoria;
  let repositorio: ReinspectionHinovaRepository;
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let service: ReinspectionHinovaService;
  let revistoriaId: number;
  let fotoId: number;

  const semear = (baseOrigin: string | null = 'MAIS_PRIME') => {
    const dono = banco.comUsuario({ baseOrigin });
    const veiculo = banco.comVeiculo({ userId: dono.id });
    revistoriaId = banco.comRevistoria({
      userVehicleId: veiculo.id,
      status: 'APROVADA',
    }).id;
    fotoId = banco.comFoto({
      reinspectionId: revistoriaId,
      nomeArquivo: 'ordem_1.jpg',
    }).id;
  };

  const lease = () =>
    banco.linha('reinspection', revistoriaId)
      .hinovaEnvioLeaseAte as Date | null;
  const foto = () => banco.linha('reinspectionPhoto', fotoId);

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('img'));
    banco = new PrismaRevistoriaMemoria();
    repositorio = new ReinspectionHinovaRepository(banco.comoPrisma());
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    service = new ReinspectionHinovaService(
      repositorio,
      new ReinspectionHinovaLoteService(sgaAuth as unknown as SgaAuthService),
    );
  });

  describe('dois envios simultâneos', () => {
    it('automáticos: um posta, o outro não envia nada', async () => {
      semear();
      const hinova = adiada<unknown>();
      sgaAuth.executeRequestWithAuth.mockReturnValue(hinova.promessa);

      const primeiro = service.enviarFotos(revistoriaId, APROVACAO);
      const segundo = await service.enviarFotos(revistoriaId, APROVACAO);

      expect(segundo).toBeNull();
      hinova.resolver(inserido('ordem_1.jpg'));
      const resultado = await primeiro;

      expect(resultado?.status).toBe('ENVIADA');
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(banco.tabelas.reinspectionHinovaEnvio).toHaveLength(1);
      expect(foto().hinovaTentativas).toBe(1);
    });

    it('reenvio manual durante um envio em andamento → 409, sem postar', async () => {
      semear();
      const hinova = adiada<unknown>();
      sgaAuth.executeRequestWithAuth.mockReturnValue(hinova.promessa);

      const primeiro = service.enviarFotos(revistoriaId, APROVACAO);
      await expect(
        service.enviarFotos(revistoriaId, MANUAL),
      ).rejects.toMatchObject({
        code: 'REVISTORIA_HINOVA_ENVIO_EM_ANDAMENTO',
        status: 409,
      });

      hinova.resolver(inserido('ordem_1.jpg'));
      await primeiro;
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(banco.tabelas.reinspectionHinovaEnvio).toHaveLength(1);
    });

    it('vários de uma vez: só um chega à Hinova', async () => {
      semear();
      sgaAuth.executeRequestWithAuth.mockResolvedValue(inserido('ordem_1.jpg'));

      const resultados = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.enviarFotos(revistoriaId, APROVACAO),
        ),
      );

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(resultados.filter((r) => r !== null)).toHaveLength(1);
    });
  });

  describe('ciclo do lease', () => {
    it('reivindica antes do HTTP e solta ao terminar', async () => {
      semear();
      let leaseDuranteAChamada: Date | null = null;
      sgaAuth.executeRequestWithAuth.mockImplementation(() => {
        leaseDuranteAChamada = lease();
        return Promise.resolve(inserido('ordem_1.jpg'));
      });

      await service.enviarFotos(revistoriaId, APROVACAO);

      expect(leaseDuranteAChamada).toBeInstanceOf(Date);
      expect(leaseDuranteAChamada!.getTime()).toBeGreaterThan(Date.now());
      expect(lease()).toBeNull();
    });

    it('solta o lease mesmo quando a gravação do resultado falha', async () => {
      semear();
      sgaAuth.executeRequestWithAuth.mockResolvedValue(inserido('ordem_1.jpg'));
      jest
        .spyOn(repositorio, 'registrarTentativa')
        .mockRejectedValueOnce(new Error('banco fora'));

      await expect(
        service.enviarFotos(revistoriaId, APROVACAO),
      ).rejects.toThrow('banco fora');
      expect(lease()).toBeNull();
    });

    it('solta o lease quando a Hinova falha (tentativa registrada como FALHA)', async () => {
      semear();
      sgaAuth.executeRequestWithAuth.mockRejectedValue(
        new Error('timeout of 60000ms exceeded'),
      );

      const resultado = await service.enviarFotos(revistoriaId, APROVACAO);

      expect(resultado?.status).toBe('FALHA');
      expect(lease()).toBeNull();
    });

    it('lease de outro processo ainda válido: automático não envia; manual → 409', async () => {
      semear();
      const futuro = new Date(Date.now() + 60_000);
      banco.linha('reinspection', revistoriaId).hinovaEnvioLeaseAte = futuro;

      await expect(
        service.enviarFotos(revistoriaId, APROVACAO),
      ).resolves.toBeNull();
      await expect(
        service.enviarFotos(revistoriaId, MANUAL),
      ).rejects.toMatchObject({ code: 'REVISTORIA_HINOVA_ENVIO_EM_ANDAMENTO' });

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      // O lease alheio não é tocado.
      expect(lease()).toEqual(futuro);
    });

    it('lease vencido (processo que morreu no meio) é assumido', async () => {
      semear();
      banco.linha('reinspection', revistoriaId).hinovaEnvioLeaseAte = new Date(
        Date.now() - 1_000,
      );
      sgaAuth.executeRequestWithAuth.mockResolvedValue(inserido('ordem_1.jpg'));

      const resultado = await service.enviarFotos(revistoriaId, MANUAL);

      expect(resultado?.status).toBe('ENVIADA');
      expect(lease()).toBeNull();
    });

    it('não solta o lease que já passou para outra execução', async () => {
      semear();
      const meu = await repositorio.reivindicarLease(
        revistoriaId,
        new Date(Date.now() - 10 * 60_000),
        1_000,
      );
      // Venceu e outra execução assumiu.
      const outro = await repositorio.reivindicarLease(
        revistoriaId,
        new Date(),
        60_000,
      );

      await repositorio.soltarLease(revistoriaId, meu!);

      expect(outro).toBeInstanceOf(Date);
      expect(lease()).toEqual(outro);
    });

    it('a lista que vale é a lida COM o lease: foto já confirmada pelo envio anterior não é repostada', async () => {
      semear();
      const reivindicar = repositorio.reivindicarLease.bind(repositorio);
      jest
        .spyOn(repositorio, 'reivindicarLease')
        .mockImplementationOnce((...args) => {
          // Entre a prévia e o lease, o envio anterior terminou e marcou a foto.
          foto().sentToHinova = true;
          return reivindicar(...args);
        });

      const resultado = await service.enviarFotos(revistoriaId, MANUAL);

      expect(resultado).toBeNull();
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(lease()).toBeNull();
    });

    it('sem foto pendente não reivindica o lease', async () => {
      semear();
      foto().sentToHinova = true;
      const reivindicar = jest.spyOn(repositorio, 'reivindicarLease');

      await expect(
        service.enviarFotos(revistoriaId, APROVACAO),
      ).resolves.toBeNull();
      expect(reivindicar).not.toHaveBeenCalled();
    });
  });

  describe('confirmação da Hinova', () => {
    it('timeout: a foto NÃO é marcada como enviada e o erro avisa do resultado incerto', async () => {
      semear();
      sgaAuth.executeRequestWithAuth.mockRejectedValue(
        new Error('timeout of 60000ms exceeded'),
      );

      const resultado = await service.enviarFotos(revistoriaId, APROVACAO);

      expect(foto()).toMatchObject({
        sentToHinova: false,
        hinovaEnviadaEm: null,
        hinovaTentativas: 1,
      });
      expect(foto().hinovaUltimoErro).toContain('resultado indeterminado');
      expect(resultado?.errorMessage).toContain('timeout of 60000ms exceeded');
      expect(banco.tabelas.reinspectionHinovaEnvio[0]).toMatchObject({
        status: 'FALHA',
        httpStatus: null,
      });
    });

    it('HTTP 200 sem a foto no retorno: a foto NÃO é marcada como enviada', async () => {
      semear();
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: [],
      });

      const resultado = await service.enviarFotos(revistoriaId, APROVACAO);

      expect(resultado?.status).toBe('FALHA');
      expect(foto().sentToHinova).toBe(false);
    });

    it('depois de um timeout, o reenvio posta a mesma foto de novo (duplicidade residual documentada)', async () => {
      semear();
      sgaAuth.executeRequestWithAuth
        .mockRejectedValueOnce(new Error('timeout of 60000ms exceeded'))
        .mockResolvedValueOnce(inserido('ordem_1.jpg'));

      await service.enviarFotos(revistoriaId, APROVACAO);
      const reenvio = await service.enviarFotos(revistoriaId, MANUAL);

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
      expect(reenvio?.status).toBe('ENVIADA');
      expect(foto().sentToHinova).toBe(true);
    });
  });

  describe('base do associado', () => {
    it.each([null, 'BASE_DE_OUTRO_DEPLOY'])(
      'base %s → BaseNaoResolvidaError, sem chamada à Hinova, sem lease e sem registro',
      async (baseOrigin) => {
        semear(baseOrigin);

        await expect(
          service.enviarFotos(revistoriaId, APROVACAO),
        ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

        expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
        expect(lease()).toBeNull();
        expect(banco.tabelas.reinspectionHinovaEnvio).toHaveLength(0);
        expect(foto().hinovaTentativas).toBe(0);
      },
    );

    it('o erro é 422 com código estável', async () => {
      semear(null);

      await expect(
        service.enviarFotos(revistoriaId, MANUAL),
      ).rejects.toMatchObject({ code: 'BASE_NAO_RESOLVIDA', status: 422 });
    });

    it('usa a base do DONO do veículo na chamada e no registro', async () => {
      semear('MAIS_PRIME_RS');
      sgaAuth.executeRequestWithAuth.mockResolvedValue(inserido('ordem_1.jpg'));

      await service.enviarFotos(revistoriaId, APROVACAO);

      expect(sgaAuth.executeRequestWithAuth.mock.calls[0][0]).toBe(
        'MAIS_PRIME_RS',
      );
      expect(banco.tabelas.reinspectionHinovaEnvio[0].baseOrigin).toBe(
        'MAIS_PRIME_RS',
      );
    });

    it('sem base mas sem foto pendente: continua devolvendo null (nada a enviar)', async () => {
      semear(null);
      foto().sentToHinova = true;

      await expect(
        service.enviarFotos(revistoriaId, APROVACAO),
      ).resolves.toBeNull();
    });
  });

  describe('reenviar (rota do painel)', () => {
    it('sem foto pendente devolve a mensagem de sempre', async () => {
      semear();
      foto().sentToHinova = true;

      await expect(service.reenviar(revistoriaId, {})).resolves.toEqual({
        reinspectionId: revistoriaId,
        envioId: null,
        status: null,
        totalFotos: 0,
        totalInseridas: 0,
        totalFalhas: 0,
        fotos: [],
        mensagem:
          'Nenhuma foto pendente de envio. Use forcar=true para reenviar fotos já inseridas.',
      });
    });

    it('com foto pendente devolve o resultado do envio', async () => {
      semear();
      sgaAuth.executeRequestWithAuth.mockResolvedValue(inserido('ordem_1.jpg'));

      const resultado = await service.reenviar(revistoriaId, {
        adminPanelUserId: 5,
      });

      expect(resultado).toMatchObject({
        reinspectionId: revistoriaId,
        status: 'ENVIADA',
        hinovaEnvioStatus: 'ENVIADA',
        totalFotos: 1,
        totalInseridas: 1,
      });
      expect(banco.tabelas.reinspectionHinovaEnvio[0]).toMatchObject({
        origem: 'REENVIO_MANUAL',
        adminPanelUserId: 5,
      });
    });
  });
});
