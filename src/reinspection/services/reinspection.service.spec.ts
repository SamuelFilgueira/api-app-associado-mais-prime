import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReinspectionVehicleType } from 'src/reinspection/dto/create-reinspection.dto';
import { montarReinspection } from 'src/reinspection/testing/montar-reinspection';

/**
 * Caracterização do `ReinspectionService`: o que cada operação devolve, o
 * que grava e quais colaboradores chama. Escrita ANTES da quebra do service
 * (fase 5) e mantida verde depois dela — a construção fica em
 * `testing/montar-reinspection.ts`; as expectativas daqui não mudam.
 *
 * Ficam de fora, de propósito, os comportamentos que a fase 4 corrige
 * (escrita de status sem condição, efeitos repetidos em chamada dobrada):
 * esses têm specs próprios nos casos de uso.
 */
describe('ReinspectionService (caracterização)', () => {
  let ambiente: ReturnType<typeof montarReinspection>;

  beforeEach(() => {
    ambiente = montarReinspection();
  });

  const veiculo = (extra: Record<string, unknown> = {}) =>
    ambiente.banco.comVeiculo({
      chassi: '9BWZZZ377VT004251',
      plate: 'ABC1D23',
      ...extra,
    });

  describe('create', () => {
    it('veículo inexistente → 404', async () => {
      await expect(
        ambiente.sujeito.create({
          userVehicleId: 999,
          vehicleType: ReinspectionVehicleType.MOTOS,
        }),
      ).rejects.toThrow(new NotFoundException('Veículo não encontrado'));
    });

    it('cria PENDENTE e devolve id, status e data', async () => {
      const v = veiculo();

      const resposta = await ambiente.sujeito.create({
        userVehicleId: v.id,
        vehicleType: ReinspectionVehicleType.MOTOS,
        codigoVeiculo: 555,
      });

      const [linha] = ambiente.banco.tabelas.reinspection;
      expect(resposta).toEqual({
        reinspectionId: linha.id,
        status: 'PENDENTE',
        createdAt: linha.createdAt,
      });
      expect(linha).toMatchObject({
        userVehicleId: v.id,
        vehicleType: 'MOTOS',
        codigoVeiculo: 555,
      });
    });

    it('sem codigoVeiculo grava null', async () => {
      const v = veiculo();
      await ambiente.sujeito.create({
        userVehicleId: v.id,
        vehicleType: ReinspectionVehicleType.VEICULOS_LEVES,
      });
      expect(ambiente.banco.tabelas.reinspection[0].codigoVeiculo).toBeNull();
    });

    it('nova tentativa depois de um envio que parou no meio (PENDENTE com fotos) cria outra revistoria', async () => {
      const v = veiculo();
      const antiga = ambiente.banco.comRevistoria({ userVehicleId: v.id });
      ambiente.banco.comFoto({ reinspectionId: antiga.id });

      const resposta = await ambiente.sujeito.create({
        userVehicleId: v.id,
        vehicleType: ReinspectionVehicleType.VEICULOS_LEVES,
      });

      expect(resposta.reinspectionId).not.toBe(antiga.id);
      expect(ambiente.banco.tabelas.reinspection).toHaveLength(2);
    });

    it.each(['APROVADA', 'FINALIZADA'])(
      'com a última revistoria %s, cria uma nova',
      async (status) => {
        const v = veiculo();
        ambiente.banco.comRevistoria({ userVehicleId: v.id, status });

        const resposta = await ambiente.sujeito.create({
          userVehicleId: v.id,
          vehicleType: ReinspectionVehicleType.VEICULOS_LEVES,
        });

        expect(resposta.status).toBe('PENDENTE');
        expect(ambiente.banco.tabelas.reinspection).toHaveLength(2);
      },
    );
  });

  describe('addPhotos', () => {
    const foto = (n: number) => ({
      nomeArquivo: `revistoria_ordem_${n}.jpg`,
      binario: `BASE64-${n}`,
      codigoTipo: n,
      templatePhotoId: undefined,
    });

    it('revistoria inexistente → 404', async () => {
      await expect(
        ambiente.sujeito.addPhotos(1, { photos: [foto(1)] }),
      ).rejects.toThrow(new NotFoundException('Revistoria não encontrada'));
    });

    it('fora de PENDENTE → 400 e nada é gravado', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'EM_ANALISE',
      });

      await expect(
        ambiente.sujeito.addPhotos(r.id, { photos: [foto(1)] }),
      ).rejects.toThrow(
        new BadRequestException(
          'Fotos só podem ser adicionadas a revistorias com status PENDENTE',
        ),
      );
      expect(
        ambiente.upload.uploadReinspectionPhotoFromBase64,
      ).not.toHaveBeenCalled();
    });

    it('foto sem nome ou sem binário → 400', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });

      await expect(
        ambiente.sujeito.addPhotos(r.id, {
          photos: [{ nomeArquivo: 'a.jpg', binario: '' }],
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Cada foto precisa informar nomeArquivo e binario',
        ),
      );
    });

    it('falha no armazenamento → 400 com a mensagem do upload', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });
      ambiente.upload.uploadReinspectionPhotoFromBase64.mockRejectedValueOnce(
        new Error('disco cheio'),
      );

      await expect(
        ambiente.sujeito.addPhotos(r.id, { photos: [foto(1)] }),
      ).rejects.toThrow(
        new BadRequestException(
          'Falha ao processar as fotos em base64 para armazenamento local',
        ),
      );
      expect(ambiente.banco.tabelas.reinspectionPhoto).toHaveLength(0);
    });

    it('grava o lote como PENDENTE, não enviado à Hinova, e devolve os totais', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });
      ambiente.banco.comFoto({ reinspectionId: r.id });

      const resposta = await ambiente.sujeito.addPhotos(r.id, {
        photos: [foto(1), foto(2)],
      });

      expect(resposta).toEqual({
        reinspectionId: r.id,
        photosAdded: 2,
        totalPhotos: 3,
      });
      expect(
        ambiente.upload.uploadReinspectionPhotoFromBase64,
      ).toHaveBeenCalledWith('BASE64-1', 'revistoria_ordem_1.jpg');
      const novas = ambiente.banco.tabelas.reinspectionPhoto.slice(1);
      expect(novas).toEqual([
        expect.objectContaining({
          reinspectionId: r.id,
          nomeArquivo: 'revistoria_ordem_1.jpg',
          codigoTipo: 1,
          templatePhotoId: null,
          status: 'PENDENTE',
          sentToHinova: false,
          url: expect.stringContaining('revistoria_ordem_1.jpg'),
        }),
        expect.objectContaining({ nomeArquivo: 'revistoria_ordem_2.jpg' }),
      ]);
    });
  });

  describe('submitReinspection', () => {
    it('revistoria inexistente → 404', async () => {
      await expect(ambiente.sujeito.submit(1)).rejects.toThrow(
        new NotFoundException('Revistoria não encontrada'),
      );
    });

    it('fora de PENDENTE → 400, sem e-mail', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'EM_ANALISE',
      });
      ambiente.banco.comFoto({ reinspectionId: r.id });

      await expect(ambiente.sujeito.submit(r.id)).rejects.toThrow(
        new BadRequestException(
          'Somente revistorias com status PENDENTE podem ser submetidas',
        ),
      );
      expect(ambiente.mail.sendRevistoriaEmail).not.toHaveBeenCalled();
    });

    it('sem foto → 400, sem e-mail', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });

      await expect(ambiente.sujeito.submit(r.id)).rejects.toThrow(
        new BadRequestException(
          'É necessário enviar pelo menos uma foto antes de submeter a revistoria',
        ),
      );
      expect(ambiente.mail.sendRevistoriaEmail).not.toHaveBeenCalled();
    });

    it('avisa os analistas por e-mail e NÃO muda o status', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });
      ambiente.banco.comFoto({ reinspectionId: r.id, url: 'uploads/a.jpg' });
      ambiente.banco.comFoto({ reinspectionId: r.id, url: 'uploads/b.jpg' });

      const resposta = await ambiente.sujeito.submit(r.id, 'dbg-1');

      expect(resposta).toMatchObject({
        reinspectionId: r.id,
        status: 'PENDENTE',
        totalPhotos: 2,
      });
      expect(ambiente.mail.sendRevistoriaEmail).toHaveBeenCalledTimes(1);
      expect(ambiente.mail.sendRevistoriaEmail).toHaveBeenCalledWith(
        '9BWZZZ377VT004251',
        'ABC1D23',
        'dbg-1',
        ['uploads/a.jpg', 'uploads/b.jpg'],
      );
      expect(ambiente.banco.linha('reinspection', r.id).status).toBe(
        'PENDENTE',
      );
    });

    it('falha no e-mail não derruba a resposta', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });
      ambiente.banco.comFoto({ reinspectionId: r.id });
      ambiente.mail.sendRevistoriaEmail.mockRejectedValueOnce(
        new Error('smtp fora'),
      );

      await expect(ambiente.sujeito.submit(r.id)).resolves.toMatchObject({
        reinspectionId: r.id,
        status: 'PENDENTE',
        totalPhotos: 1,
      });
    });
  });

  describe('leituras do painel', () => {
    it('getDashboardTotals conta por status', async () => {
      const v = veiculo();
      for (const status of [
        'APROVADA',
        'APROVADA',
        'EM_ANALISE',
        'REPROVADA',
        'PENDENTE',
        'FINALIZADA',
      ]) {
        ambiente.banco.comRevistoria({ userVehicleId: v.id, status });
      }

      await expect(ambiente.sujeito.getDashboardTotals()).resolves.toEqual({
        aprovadas: 2,
        emAnalise: 1,
        reprovadas: 1,
        totalRevistorias: 6,
      });
    });

    const camposDaLista = (linha: Record<string, unknown>) => ({
      id: linha.id,
      userVehicleId: linha.userVehicleId,
      vehicleType: linha.vehicleType,
      status: linha.status,
      hinovaEnvioStatus: 'NAO_ENVIADA',
      hinovaUltimoEnvioEm: null,
      boletoStatus: 'NAO_GERADO',
      boletoTentativas: 0,
      boletoUltimaTentativaEm: null,
      boletoProximaTentativaEm: null,
      boletoUltimoErro: null,
      boletoNossoNumero: null,
      boletoOrigem: null,
      createdAt: linha.createdAt,
      updatedAt: linha.updatedAt,
      chassi: '9BWZZZ377VT004251',
      plate: 'ABC1D23',
    });

    it('listAll devolve da mais nova para a mais antiga, com chassi, placa e total de fotos', async () => {
      const v = veiculo();
      const antiga = ambiente.banco.comRevistoria({ userVehicleId: v.id });
      const nova = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
      });
      ambiente.banco.comFoto({ reinspectionId: nova.id });

      await expect(ambiente.sujeito.listAll()).resolves.toEqual([
        { ...camposDaLista(nova), _count: { photos: 1 } },
        { ...camposDaLista(antiga), _count: { photos: 0 } },
      ]);
    });

    it('listRecent usa 20 por padrão e limita em 100', async () => {
      const v = veiculo();
      for (let i = 0; i < 130; i++) {
        ambiente.banco.comRevistoria({ userVehicleId: v.id });
      }

      await expect(ambiente.sujeito.listRecent()).resolves.toHaveLength(20);
      await expect(ambiente.sujeito.listRecent(5)).resolves.toHaveLength(5);
      await expect(ambiente.sujeito.listRecent(1000)).resolves.toHaveLength(
        100,
      );
    });

    it('listRecent devolve o mesmo formato de listAll', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });

      await expect(ambiente.sujeito.listRecent()).resolves.toEqual([
        { ...camposDaLista(r), _count: { photos: 0 } },
      ]);
    });

    it('search sem chassi nem placa → 400', async () => {
      await expect(ambiente.sujeito.search('  ', undefined)).rejects.toThrow(
        new BadRequestException(
          'Informe ao menos um parâmetro de busca: chassi ou plate',
        ),
      );
    });

    it('search casa por trecho do chassi OU da placa', async () => {
      const a = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });
      const outro = ambiente.banco.comVeiculo({
        chassi: 'XYZ000',
        plate: 'QQQ9999',
      });
      const b = ambiente.banco.comRevistoria({ userVehicleId: outro.id });

      const porChassi = await ambiente.sujeito.search(' 377VT ', undefined);
      expect(porChassi).toEqual([
        { ...camposDaLista(a), _count: { photos: 0 } },
      ]);

      const porPlaca = await ambiente.sujeito.search(undefined, 'QQQ');
      expect(porPlaca.map((r) => r.id)).toEqual([b.id]);

      // O painel manda o mesmo termo nos dois parâmetros.
      const ambos = await ambiente.sujeito.search('QQQ9', 'QQQ9');
      expect(ambos.map((r) => r.id)).toEqual([b.id]);
    });

    it('getById: inexistente → 404', async () => {
      await expect(ambiente.sujeito.getById(1)).rejects.toThrow(
        new NotFoundException('Revistoria não encontrada'),
      );
    });

    it('getById devolve o detalhe com codigoVeiculo e as contagens', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        codigoVeiculo: 77,
      });
      ambiente.banco.comFoto({ reinspectionId: r.id });

      await expect(ambiente.sujeito.getById(r.id)).resolves.toEqual({
        ...camposDaLista(r),
        codigoVeiculo: 77,
        _count: { photos: 1, hinovaEnvios: 0 },
      });
    });

    it('getPhotos: inexistente → 404', async () => {
      await expect(ambiente.sujeito.getPhotos(1)).rejects.toThrow(
        new NotFoundException('Revistoria não encontrada'),
      );
    });

    it('getPhotos devolve as fotos em ordem de id, com a URL pública', async () => {
      const r = ambiente.banco.comRevistoria({ userVehicleId: veiculo().id });
      const f1 = ambiente.banco.comFoto({
        reinspectionId: r.id,
        url: 'uploads/1.jpg',
        codigoTipo: 3,
      });
      const f2 = ambiente.banco.comFoto({
        reinspectionId: r.id,
        url: 'uploads/2.jpg',
        status: 'APROVADA',
        sentToHinova: true,
        hinovaSituacao: 'Inserido',
      });

      await expect(ambiente.sujeito.getPhotos(r.id)).resolves.toEqual({
        reinspectionId: r.id,
        chassi: '9BWZZZ377VT004251',
        plate: 'ABC1D23',
        totalPhotos: 2,
        photos: [
          {
            id: f1.id,
            reinspectionId: r.id,
            nomeArquivo: f1.nomeArquivo,
            codigoTipo: 3,
            url: 'https://api.teste/uploads/1.jpg',
            status: 'PENDENTE',
            hinovaSituacao: null,
            sentToHinova: false,
            hinovaEnviadaEm: null,
            hinovaTentativas: 0,
            hinovaUltimoErro: null,
            createdAt: f1.createdAt,
          },
          expect.objectContaining({
            id: f2.id,
            url: 'https://api.teste/uploads/2.jpg',
            status: 'APROVADA',
            sentToHinova: true,
            hinovaSituacao: 'Inserido',
          }),
        ],
      });
    });
  });

  describe('templates', () => {
    it('upsertTemplatePhoto sem arquivo → 400', async () => {
      await expect(
        ambiente.sujeito.upsertTemplatePhoto(
          { vehicleType: ReinspectionVehicleType.MOTOS, ordem: 1 },
          undefined,
        ),
      ).rejects.toThrow(
        new BadRequestException('Foto do template é obrigatória'),
      );
    });

    it('upsertTemplatePhoto cria o template novo sem apagar arquivo', async () => {
      const resposta = await ambiente.sujeito.upsertTemplatePhoto(
        { vehicleType: ReinspectionVehicleType.MOTOS, ordem: 2 },
        { originalname: 'a.jpg' },
      );

      const [linha] = ambiente.banco.tabelas.reinspectionTemplatePhoto;
      expect(resposta).toEqual({
        id: linha.id,
        vehicleType: 'MOTOS',
        ordem: 2,
        photoUrl: `https://api.teste/${String(linha.photoUrl)}`,
      });
      expect(
        ambiente.upload.deleteReinspectionTemplatePhoto,
      ).not.toHaveBeenCalled();
    });

    it('upsertTemplatePhoto troca a foto existente e apaga o arquivo antigo', async () => {
      const existente = ambiente.banco.comTemplate({
        vehicleType: 'MOTOS',
        ordem: 2,
        photoUrl: 'uploads/reinspection-templates/antigo.jpg',
      });

      const resposta = await ambiente.sujeito.upsertTemplatePhoto(
        { vehicleType: ReinspectionVehicleType.MOTOS, ordem: 2 },
        { originalname: 'novo.jpg' },
      );

      expect(resposta.id).toBe(existente.id);
      expect(
        ambiente.upload.deleteReinspectionTemplatePhoto,
      ).toHaveBeenCalledWith('uploads/reinspection-templates/antigo.jpg');
      expect(ambiente.banco.tabelas.reinspectionTemplatePhoto).toHaveLength(1);
      expect(existente.photoUrl).not.toBe(
        'uploads/reinspection-templates/antigo.jpg',
      );
    });

    it('getTemplatePhotos filtra por tipo e ordena por ordem', async () => {
      ambiente.banco.comTemplate({
        vehicleType: 'MOTOS',
        ordem: 2,
        photoUrl: 'uploads/t2.jpg',
      });
      ambiente.banco.comTemplate({
        vehicleType: 'MOTOS',
        ordem: 1,
        photoUrl: 'uploads/t1.jpg',
      });
      ambiente.banco.comTemplate({ vehicleType: 'CAMINHOES', ordem: 1 });

      await expect(
        ambiente.sujeito.getTemplatePhotos('MOTOS'),
      ).resolves.toEqual([
        {
          photoUrl: 'https://api.teste/uploads/t1.jpg',
          ordem: 1,
          vehicleType: 'MOTOS',
        },
        {
          photoUrl: 'https://api.teste/uploads/t2.jpg',
          ordem: 2,
          vehicleType: 'MOTOS',
        },
      ]);
      await expect(ambiente.sujeito.getTemplatePhotos()).resolves.toHaveLength(
        3,
      );
    });
  });

  describe('getStatusByUserVehicleId', () => {
    it('veículo inexistente → 404', async () => {
      await expect(ambiente.sujeito.getStatus(9)).rejects.toThrow(
        new NotFoundException('Veículo não encontrado'),
      );
    });

    it('sem revistoria devolve hasReinspection=false', async () => {
      const v = veiculo();
      await expect(ambiente.sujeito.getStatus(v.id)).resolves.toEqual({
        userVehicleId: v.id,
        chassi: '9BWZZZ377VT004251',
        plate: 'ABC1D23',
        hasReinspection: false,
        status: null,
      });
    });

    it('devolve a revistoria MAIS RECENTE do veículo', async () => {
      const v = veiculo();
      ambiente.banco.comRevistoria({ userVehicleId: v.id, status: 'APROVADA' });
      const nova = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
      });

      await expect(ambiente.sujeito.getStatus(v.id)).resolves.toEqual({
        userVehicleId: v.id,
        chassi: '9BWZZZ377VT004251',
        plate: 'ABC1D23',
        hasReinspection: true,
        reinspectionId: nova.id,
        status: 'EM_ANALISE',
        createdAt: nova.createdAt,
        updatedAt: nova.updatedAt,
      });
    });
  });

  describe('updateStatusByUserVehicleId (PATCH /status)', () => {
    it('veículo inexistente → 404', async () => {
      await expect(ambiente.sujeito.marcarEmAnalise(9)).rejects.toThrow(
        new NotFoundException('Veículo não encontrado'),
      );
    });

    it('sem revistoria devolve hasReinspection=false', async () => {
      const v = veiculo();
      await expect(ambiente.sujeito.marcarEmAnalise(v.id)).resolves.toEqual({
        userVehicleId: v.id,
        hasReinspection: false,
        status: null,
      });
    });

    it.each(['PENDENTE', 'REPROVADA'])(
      '%s → EM_ANALISE na última revistoria do veículo',
      async (status) => {
        const v = veiculo();
        const antiga = ambiente.banco.comRevistoria({
          userVehicleId: v.id,
          status: 'FINALIZADA',
        });
        const r = ambiente.banco.comRevistoria({ userVehicleId: v.id, status });

        const resposta = await ambiente.sujeito.marcarEmAnalise(v.id);

        expect(resposta).toEqual({
          userVehicleId: v.id,
          hasReinspection: true,
          reinspectionId: r.id,
          status: 'EM_ANALISE',
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        expect(antiga.status).toBe('FINALIZADA');
      },
    );

    it('já EM_ANALISE continua respondendo EM_ANALISE', async () => {
      const v = veiculo();
      ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
      });

      await expect(
        ambiente.sujeito.marcarEmAnalise(v.id),
      ).resolves.toMatchObject({ hasReinspection: true, status: 'EM_ANALISE' });
    });
  });

  describe('finalizeByUserVehicleId (PATCH /finalizar)', () => {
    it('veículo inexistente → 404', async () => {
      await expect(ambiente.sujeito.finalizar(9)).rejects.toThrow(
        new NotFoundException('Veículo não encontrado'),
      );
    });

    it('sem revistoria → 404', async () => {
      const v = veiculo();
      await expect(ambiente.sujeito.finalizar(v.id)).rejects.toThrow(
        new NotFoundException(
          'Nenhuma revistoria encontrada para este veículo',
        ),
      );
    });

    it.each(['PENDENTE', 'EM_ANALISE', 'APROVADA', 'REPROVADA'])(
      '%s → FINALIZADA',
      async (status) => {
        const v = veiculo();
        const r = ambiente.banco.comRevistoria({ userVehicleId: v.id, status });

        const resposta = await ambiente.sujeito.finalizar(v.id);

        expect(resposta).toEqual({
          reinspectionId: r.id,
          userVehicleId: v.id,
          status: 'FINALIZADA',
          updatedAt: r.updatedAt,
        });
      },
    );

    it('já FINALIZADA continua respondendo FINALIZADA', async () => {
      const v = veiculo();
      ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'FINALIZADA',
      });

      await expect(ambiente.sujeito.finalizar(v.id)).resolves.toMatchObject({
        status: 'FINALIZADA',
      });
    });
  });

  describe('approveByUserVehicleId (PATCH /aprovar)', () => {
    it('veículo inexistente → 404', async () => {
      await expect(ambiente.sujeito.aprovar(9)).rejects.toThrow(
        new NotFoundException('Veículo não encontrado'),
      );
    });

    it('sem revistoria → 404', async () => {
      const v = veiculo();
      await expect(ambiente.sujeito.aprovar(v.id)).rejects.toThrow(
        new NotFoundException(
          'Nenhuma revistoria encontrada para este veículo',
        ),
      );
    });

    it('com foto reprovada → 400, sem Hinova nem boleto', async () => {
      const v = veiculo();
      const r = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
      });
      ambiente.banco.comFoto({ reinspectionId: r.id, status: 'REPROVADA' });

      await expect(ambiente.sujeito.aprovar(v.id)).rejects.toThrow(
        new BadRequestException(
          'Não é possível aprovar uma revistoria com foto reprovada',
        ),
      );
      expect(r.status).toBe('EM_ANALISE');
      expect(ambiente.hinova.enviarFotos).not.toHaveBeenCalled();
      expect(ambiente.boleto.processar).not.toHaveBeenCalled();
    });

    it.each(['EM_ANALISE', 'PENDENTE'])(
      '%s → APROVADA; envia as fotos à Hinova e dispara o boleto, nessa ordem',
      async (status) => {
        const v = veiculo();
        const r = ambiente.banco.comRevistoria({ userVehicleId: v.id, status });
        ambiente.banco.comFoto({ reinspectionId: r.id, status: 'APROVADA' });

        const resposta = await ambiente.sujeito.aprovar(v.id, 'dbg-2', {
          userId: 5,
          email: 'analista@teste.local',
        });

        expect(resposta).toMatchObject({
          reinspectionId: r.id,
          userVehicleId: v.id,
          status: 'APROVADA',
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          boleto: {
            status: 'GERADO',
            nossoNumero: '123',
            tentativas: 1,
            proximaTentativaEm: null,
            erro: null,
          },
        });
        expect(r.status).toBe('APROVADA');
        expect(ambiente.hinova.enviarFotos).toHaveBeenCalledTimes(1);
        expect(ambiente.hinova.enviarFotos).toHaveBeenCalledWith(r.id, {
          origem: 'APROVACAO',
          adminPanelUserId: 5,
          adminPanelUserEmail: 'analista@teste.local',
          debugId: 'dbg-2',
        });
        expect(ambiente.boleto.processar).toHaveBeenCalledTimes(1);
        expect(ambiente.boleto.processar).toHaveBeenCalledWith(r.id, {
          origem: 'APROVACAO',
          debugId: 'dbg-2',
        });
        expect(
          ambiente.hinova.enviarFotos.mock.invocationCallOrder[0],
        ).toBeLessThan(ambiente.boleto.processar.mock.invocationCallOrder[0]);
      },
    );

    it('falha no envio à Hinova não desfaz a aprovação nem impede o boleto', async () => {
      const v = veiculo();
      const r = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
      });
      ambiente.hinova.enviarFotos.mockRejectedValueOnce(
        new Error('hinova fora'),
      );

      const resposta = await ambiente.sujeito.aprovar(v.id);

      expect(resposta.status).toBe('APROVADA');
      expect(r.status).toBe('APROVADA');
      expect(ambiente.boleto.processar).toHaveBeenCalledTimes(1);
    });

    it('falha inesperada no boleto não desfaz a aprovação: boleto vem null', async () => {
      const v = veiculo();
      const r = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
      });
      ambiente.boleto.processar.mockRejectedValueOnce(new Error('inesperado'));

      const resposta = await ambiente.sujeito.aprovar(v.id);

      expect(resposta).toMatchObject({ status: 'APROVADA', boleto: null });
      expect(r.status).toBe('APROVADA');
    });
  });

  describe('getRejectedPhotos', () => {
    it('veículo inexistente → 404', async () => {
      await expect(ambiente.sujeito.getRejectedPhotos(9)).rejects.toThrow(
        new NotFoundException('Veículo não encontrado'),
      );
    });

    it('sem revistoria → 404', async () => {
      const v = veiculo();
      await expect(ambiente.sujeito.getRejectedPhotos(v.id)).rejects.toThrow(
        new NotFoundException(
          'Nenhuma revistoria encontrada para este veículo',
        ),
      );
    });

    it('devolve só as reprovadas da última revistoria, com o template', async () => {
      const v = veiculo();
      const r = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'REPROVADA',
      });
      const template = ambiente.banco.comTemplate({
        vehicleType: 'VEICULOS_LEVES',
        ordem: 4,
        photoUrl: 'uploads/t4.jpg',
      });
      ambiente.banco.comFoto({ reinspectionId: r.id, status: 'APROVADA' });
      const comTemplate = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
        url: 'uploads/f.jpg',
        templatePhotoId: template.id,
      });
      const semTemplate = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
        url: 'uploads/g.jpg',
      });

      await expect(ambiente.sujeito.getRejectedPhotos(v.id)).resolves.toEqual({
        reinspectionId: r.id,
        chassi: '9BWZZZ377VT004251',
        plate: 'ABC1D23',
        reinspectionStatus: 'REPROVADA',
        rejectedPhotos: [
          {
            photoId: comTemplate.id,
            photoUrl: 'https://api.teste/uploads/f.jpg',
            templatePhotoId: template.id,
            templatePhotoUrl: 'https://api.teste/uploads/t4.jpg',
            ordem: 4,
            templatePhoto: {
              id: template.id,
              vehicleType: 'VEICULOS_LEVES',
              ordem: 4,
              photoUrl: 'https://api.teste/uploads/t4.jpg',
            },
          },
          {
            photoId: semTemplate.id,
            photoUrl: 'https://api.teste/uploads/g.jpg',
            templatePhotoId: null,
            templatePhotoUrl: null,
            ordem: null,
            templatePhoto: null,
          },
        ],
      });
    });
  });

  describe('resendPhoto', () => {
    it('foto inexistente → 404', async () => {
      await expect(ambiente.sujeito.resendPhoto(1, 'B64')).rejects.toThrow(
        new NotFoundException('Foto de revistoria não encontrada'),
      );
    });

    it('foto que não está reprovada → 400, sem upload', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'EM_ANALISE',
      });
      const f = ambiente.banco.comFoto({ reinspectionId: r.id });

      await expect(ambiente.sujeito.resendPhoto(f.id, 'B64')).rejects.toThrow(
        new BadRequestException(
          'Somente fotos reprovadas podem ser reenviadas',
        ),
      );
      expect(
        ambiente.upload.uploadReinspectionPhotoFromBase64,
      ).not.toHaveBeenCalled();
    });

    it('troca o arquivo, volta a foto para PENDENTE e a revistoria para EM_ANALISE, e avisa por e-mail', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'REPROVADA',
      });
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
        nomeArquivo: 'revistoria_ordem_2.jpg',
        sentToHinova: true,
        hinovaSituacao: 'Inserido',
      });

      const resposta = await ambiente.sujeito.resendPhoto(f.id, 'B64', 'dbg-3');

      const novaUrl = f.url as string;
      expect(
        ambiente.upload.uploadReinspectionPhotoFromBase64,
      ).toHaveBeenCalledWith('B64', 'revistoria_ordem_2.jpg');
      expect(resposta).toMatchObject({
        photoId: f.id,
        reinspectionId: r.id,
        reinspectionStatus: 'EM_ANALISE',
        photoStatus: 'PENDENTE',
        photoUrl: `https://api.teste/${novaUrl}`,
      });
      expect(f).toMatchObject({
        status: 'PENDENTE',
        sentToHinova: false,
        hinovaSituacao: null,
      });
      expect(novaUrl).toContain('revistoria_ordem_2.jpg');
      expect(r.status).toBe('EM_ANALISE');
      expect(ambiente.mail.sendFotoRecusadaReenviadaEmail).toHaveBeenCalledWith(
        '9BWZZZ377VT004251',
        'ABC1D23',
        'dbg-3',
        [novaUrl],
      );
    });

    it('falha no e-mail não derruba a resposta', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'REPROVADA',
      });
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
      });
      ambiente.mail.sendFotoRecusadaReenviadaEmail.mockRejectedValueOnce(
        new Error('smtp fora'),
      );

      await expect(
        ambiente.sujeito.resendPhoto(f.id, 'B64'),
      ).resolves.toMatchObject({ photoStatus: 'PENDENTE' });
    });
  });

  describe('reprovePhoto', () => {
    it('foto inexistente → 404', async () => {
      await expect(ambiente.sujeito.reprovePhoto(1)).rejects.toThrow(
        new NotFoundException('Foto de revistoria não encontrada'),
      );
    });

    it('reprova a foto e a revistoria; infere o template pela ordem no nome do arquivo', async () => {
      const v = veiculo();
      const r = ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        status: 'EM_ANALISE',
        vehicleType: 'MOTOS',
      });
      const template = ambiente.banco.comTemplate({
        vehicleType: 'MOTOS',
        ordem: 3,
      });
      ambiente.banco.comTemplate({ vehicleType: 'CAMINHOES', ordem: 3 });
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        nomeArquivo: 'revistoria_ordem_3_1.jpg',
      });

      const resposta = await ambiente.sujeito.reprovePhoto(f.id);

      expect(resposta).toEqual({
        photo: {
          id: f.id,
          reinspectionId: r.id,
          nomeArquivo: 'revistoria_ordem_3_1.jpg',
          templatePhotoId: template.id,
          status: 'REPROVADA',
        },
        reinspection: {
          reinspectionId: r.id,
          userVehicleId: v.id,
          status: 'REPROVADA',
          updatedAt: r.updatedAt,
        },
      });
      expect(f.status).toBe('REPROVADA');
      expect(r.status).toBe('REPROVADA');
    });

    it('mantém o template já gravado na foto', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'EM_ANALISE',
      });
      const template = ambiente.banco.comTemplate({ ordem: 9 });
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        nomeArquivo: 'revistoria_ordem_1.jpg',
        templatePhotoId: template.id,
      });

      const resposta = await ambiente.sujeito.reprovePhoto(f.id);

      expect(resposta.photo.templatePhotoId).toBe(template.id);
    });

    it.each([
      ['sem ordem no nome', 'foto.jpg'],
      ['ordem sem template cadastrado', 'revistoria_ordem_42.jpg'],
    ])('%s → templatePhotoId null', async (_caso, nomeArquivo) => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'EM_ANALISE',
      });
      const f = ambiente.banco.comFoto({ reinspectionId: r.id, nomeArquivo });

      const resposta = await ambiente.sujeito.reprovePhoto(f.id);

      expect(resposta.photo.templatePhotoId).toBeNull();
      expect(resposta.reinspection.status).toBe('REPROVADA');
    });
  });

  describe('approvePhoto', () => {
    it('foto inexistente → 404', async () => {
      await expect(ambiente.sujeito.approvePhoto(1)).rejects.toThrow(
        new NotFoundException('Foto de revistoria não encontrada'),
      );
    });

    it.each(['PENDENTE', 'EM_ANALISE', 'REPROVADA'])(
      'revistoria %s sem outra foto reprovada → EM_ANALISE',
      async (status) => {
        const v = veiculo();
        const r = ambiente.banco.comRevistoria({ userVehicleId: v.id, status });
        const f = ambiente.banco.comFoto({
          reinspectionId: r.id,
          status: status === 'REPROVADA' ? 'REPROVADA' : 'PENDENTE',
        });

        const resposta = await ambiente.sujeito.approvePhoto(f.id);

        expect(resposta).toEqual({
          photo: {
            id: f.id,
            reinspectionId: r.id,
            nomeArquivo: f.nomeArquivo,
            templatePhotoId: null,
            status: 'APROVADA',
          },
          reinspection: {
            reinspectionId: r.id,
            userVehicleId: v.id,
            status: 'EM_ANALISE',
            updatedAt: r.updatedAt,
          },
        });
        expect(r.status).toBe('EM_ANALISE');
      },
    );

    it('com outra foto ainda reprovada, a revistoria fica REPROVADA', async () => {
      const r = ambiente.banco.comRevistoria({
        userVehicleId: veiculo().id,
        status: 'EM_ANALISE',
      });
      ambiente.banco.comFoto({ reinspectionId: r.id, status: 'REPROVADA' });
      const f = ambiente.banco.comFoto({ reinspectionId: r.id });

      const resposta = await ambiente.sujeito.approvePhoto(f.id);

      expect(resposta.photo.status).toBe('APROVADA');
      expect(resposta.reinspection.status).toBe('REPROVADA');
      expect(r.status).toBe('REPROVADA');
    });
  });
});
