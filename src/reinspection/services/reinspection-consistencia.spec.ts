import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReinspectionVehicleType } from 'src/reinspection/dto/create-reinspection.dto';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { ReinspectionAprovacaoService } from 'src/reinspection/services/reinspection-aprovacao.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { montarReinspection } from 'src/reinspection/testing/montar-reinspection';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import { DomainError } from 'src/shared/erros/erros';

/**
 * Consistência da revistoria (fase 4): transições condicionais, repetição
 * idempotente e efeito colateral só para quem ganhou a transição.
 *
 * As corridas são reproduzidas com chamadas simultâneas sobre o Prisma em
 * memória (cada operação é atômica e as chamadas se intercalam nos `await`).
 * A versão contra o banco real está em `test/integracao/revistoria-*`.
 */
describe('Revistoria — consistência', () => {
  let ambiente: ReturnType<typeof montarReinspection>;

  beforeEach(() => {
    ambiente = montarReinspection();
  });

  const veiculo = () =>
    ambiente.banco.comVeiculo({
      chassi: '9BWZZZ377VT004251',
      plate: 'ABC1D23',
    });

  const revistoria = (status: string, extra: Record<string, unknown> = {}) => {
    const v = veiculo();
    const r = ambiente.banco.comRevistoria({
      userVehicleId: v.id,
      status,
      ...extra,
    });
    return { v, r };
  };

  const erro409 = (code: string) =>
    expect.objectContaining({ code, status: 409 });

  describe('ReinspectionRepository.transicionar', () => {
    let repositorio: ReinspectionRepository;

    beforeEach(() => {
      repositorio = new ReinspectionRepository(ambiente.banco.comoPrisma());
    });

    it('estado de origem aceito → grava e devolve ganhou=true', async () => {
      const { r } = revistoria('EM_ANALISE');

      await expect(
        repositorio.transicionar(r.id, ['PENDENTE', 'EM_ANALISE'], 'APROVADA'),
      ).resolves.toEqual({ ganhou: true, status: 'APROVADA' });
      expect(r.status).toBe('APROVADA');
    });

    it('grava com UPDATE condicionado ao status (updateMany + count)', async () => {
      const { r } = revistoria('EM_ANALISE');
      const updateMany = jest.spyOn(ambiente.banco.reinspection, 'updateMany');
      const update = jest.spyOn(ambiente.banco.reinspection, 'update');

      await repositorio.transicionar(r.id, ['EM_ANALISE'], 'APROVADA');

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: r.id, status: { in: ['EM_ANALISE'] } },
        data: { status: 'APROVADA' },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('já no destino + repetição aceita → ganhou=false, sem gravar', async () => {
      const { r } = revistoria('APROVADA');
      const antes = r.updatedAt;

      await expect(
        repositorio.transicionar(r.id, ['EM_ANALISE'], 'APROVADA', {
          repeticaoIdempotente: true,
        }),
      ).resolves.toEqual({ ganhou: false, status: 'APROVADA' });
      expect(r.updatedAt).toBe(antes);
    });

    it('já no destino sem repetição aceita → 409', async () => {
      const { r } = revistoria('APROVADA');

      await expect(
        repositorio.transicionar(r.id, ['EM_ANALISE'], 'APROVADA'),
      ).rejects.toEqual(erro409('REVISTORIA_TRANSICAO_INVALIDA'));
    });

    it('estado que não admite a transição → 409 com os dois estados', async () => {
      const { r } = revistoria('FINALIZADA');

      const erro = await repositorio
        .transicionar(r.id, ['PENDENTE', 'EM_ANALISE'], 'APROVADA', {
          repeticaoIdempotente: true,
        })
        .catch((e: DomainError) => e);

      expect(erro).toBeInstanceOf(DomainError);
      expect(erro).toMatchObject({
        code: 'REVISTORIA_TRANSICAO_INVALIDA',
        status: 409,
        detalhes: { statusAtual: 'FINALIZADA', statusPretendido: 'APROVADA' },
      });
      expect(r.status).toBe('FINALIZADA');
    });

    it('revistoria inexistente → 404', async () => {
      await expect(
        repositorio.transicionar(999, ['EM_ANALISE'], 'APROVADA'),
      ).rejects.toThrow(new NotFoundException('Revistoria não encontrada'));
    });

    it('aresta fora da tabela é erro de programação e não chega ao banco', async () => {
      const { r } = revistoria('FINALIZADA');
      const updateMany = jest.spyOn(ambiente.banco.reinspection, 'updateMany');

      await expect(
        repositorio.transicionar(r.id, ['FINALIZADA'], 'APROVADA'),
      ).rejects.toThrow('fora da tabela');
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('duas transições simultâneas: uma ganha, a outra não', async () => {
      const { r } = revistoria('EM_ANALISE');
      const tentar = () =>
        repositorio.transicionar(r.id, ['EM_ANALISE'], 'APROVADA', {
          repeticaoIdempotente: true,
        });

      const resultados = await Promise.all([tentar(), tentar(), tentar()]);

      expect(resultados.filter((x) => x.ganhou)).toHaveLength(1);
      expect(resultados.every((x) => x.status === 'APROVADA')).toBe(true);
    });
  });

  describe('aprovar', () => {
    it('duas aprovações simultâneas: UM envio à Hinova e UM boleto (que é quem manda o e-mail)', async () => {
      const { v, r } = revistoria('EM_ANALISE');
      ambiente.banco.comFoto({ reinspectionId: r.id, status: 'APROVADA' });

      const respostas = await Promise.all([
        ambiente.sujeito.aprovar(v.id, 'dbg-a'),
        ambiente.sujeito.aprovar(v.id, 'dbg-b'),
      ]);

      expect(ambiente.hinova.enviarFotos).toHaveBeenCalledTimes(1);
      expect(ambiente.boleto.processar).toHaveBeenCalledTimes(1);
      expect(respostas.map((x) => x.status)).toEqual(['APROVADA', 'APROVADA']);
      expect(respostas.map((x) => x.repetida).sort()).toEqual([false, true]);
      expect(r.status).toBe('APROVADA');
    });

    it('aprovação repetida responde o estado atual, sem refazer nada', async () => {
      const { v, r } = revistoria('APROVADA', {
        boletoStatus: 'GERADO',
        boletoNossoNumero: '999',
        boletoTentativas: 2,
      });

      const resposta = await ambiente.sujeito.aprovar(v.id);

      expect(resposta).toEqual({
        reinspectionId: r.id,
        userVehicleId: v.id,
        status: 'APROVADA',
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        boleto: {
          status: 'GERADO',
          nossoNumero: '999',
          tentativas: 2,
          proximaTentativaEm: null,
          erro: null,
        },
        repetida: true,
        hinovaEnvio: null,
        falhas: [],
      });
      expect(ambiente.hinova.enviarFotos).not.toHaveBeenCalled();
      expect(ambiente.boleto.processar).not.toHaveBeenCalled();
    });

    it('já APROVADA e sem tentativa de boleto (processo caiu no meio): aprovar de novo retoma os efeitos', async () => {
      const { v, r } = revistoria('APROVADA', { boletoStatus: 'NAO_GERADO' });
      ambiente.banco.comFoto({ reinspectionId: r.id, status: 'APROVADA' });

      const resposta = await ambiente.sujeito.aprovar(v.id, 'dbg-retomada');

      expect(ambiente.boleto.processar).toHaveBeenCalledTimes(1);
      expect(ambiente.boleto.processar).toHaveBeenCalledWith(
        r.id,
        expect.objectContaining({ origem: 'APROVACAO' }),
      );
      expect(ambiente.hinova.enviarFotos).toHaveBeenCalledTimes(1);
      expect(resposta.repetida).toBe(true);
      expect(resposta.status).toBe('APROVADA');
    });

    it.each(['PENDENTE_RETRY', 'FALHA', 'GERADO'])(
      'já APROVADA com boleto %s: aprovar de novo não refaz nada (há o retry e o "gerar agora")',
      async (boletoStatus) => {
        const { v } = revistoria('APROVADA', { boletoStatus });

        const resposta = await ambiente.sujeito.aprovar(v.id);

        expect(resposta.repetida).toBe(true);
        expect(ambiente.hinova.enviarFotos).not.toHaveBeenCalled();
        expect(ambiente.boleto.processar).not.toHaveBeenCalled();
      },
    );

    it('repositório que diz "não ganhou" → nenhum efeito (a decisão vem da transição, não de leitura prévia)', async () => {
      const estado = {
        id: 7,
        userVehicleId: 3,
        status: 'APROVADA',
        createdAt: new Date(),
        updatedAt: new Date(),
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 1,
        boletoProximaTentativaEm: null,
        boletoUltimoErro: 'SGA fora',
        boletoNossoNumero: null,
      };
      const revistorias = {
        veiculo: jest.fn().mockResolvedValue({ id: 3, userId: 1 }),
        // A leitura ainda mostra EM_ANALISE: outra aprovação está no meio.
        ultimaDoVeiculo: jest
          .fn()
          .mockResolvedValue({ id: 7, status: 'EM_ANALISE' }),
        transicionar: jest
          .fn()
          .mockResolvedValue({ ganhou: false, status: 'APROVADA' }),
        estadoOuFalha: jest.fn().mockResolvedValue(estado),
      };
      const fotos = { existeReprovada: jest.fn().mockResolvedValue(false) };
      const hinova = { enviarFotos: jest.fn() };
      const boleto = { processar: jest.fn() };
      const service = new ReinspectionAprovacaoService(
        revistorias as unknown as ReinspectionRepository,
        fotos as unknown as ReinspectionPhotoRepository,
        hinova as unknown as ReinspectionHinovaService,
        boleto as unknown as BoletoReativacaoService,
      );

      const resposta = await service.aprovar(3);

      expect(revistorias.transicionar).toHaveBeenCalledWith(
        7,
        ['PENDENTE', 'EM_ANALISE'],
        'APROVADA',
        { repeticaoIdempotente: true },
      );
      expect(hinova.enviarFotos).not.toHaveBeenCalled();
      expect(boleto.processar).not.toHaveBeenCalled();
      expect(resposta).toMatchObject({
        status: 'APROVADA',
        repetida: true,
        boleto: { status: 'PENDENTE_RETRY', erro: 'SGA fora' },
      });
    });

    it.each(['FINALIZADA', 'REPROVADA'])(
      'revistoria %s não é aprovada: 409, sem Hinova nem boleto',
      async (status) => {
        const { v, r } = revistoria(status);

        await expect(ambiente.sujeito.aprovar(v.id)).rejects.toEqual(
          erro409('REVISTORIA_TRANSICAO_INVALIDA'),
        );
        expect(r.status).toBe(status);
        expect(ambiente.hinova.enviarFotos).not.toHaveBeenCalled();
        expect(ambiente.boleto.processar).not.toHaveBeenCalled();
      },
    );

    it('aprovar e reprovar foto ao mesmo tempo nunca termina APROVADA com foto reprovada', async () => {
      const { v, r } = revistoria('EM_ANALISE');
      const f = ambiente.banco.comFoto({ reinspectionId: r.id });

      await Promise.allSettled([
        ambiente.sujeito.aprovar(v.id),
        ambiente.sujeito.reprovePhoto(f.id),
      ]);

      expect(f.status).toBe('REPROVADA');
      expect(r.status).toBe('REPROVADA');
    });

    it('falha no envio à Hinova aparece em `falhas` e o boleto segue', async () => {
      const { v } = revistoria('EM_ANALISE');
      ambiente.hinova.enviarFotos.mockRejectedValueOnce(
        new Error('hinova fora'),
      );

      const resposta = await ambiente.sujeito.aprovar(v.id);

      expect(resposta.falhas).toEqual([
        { etapa: 'HINOVA', erro: 'hinova fora' },
      ]);
      expect(resposta.hinovaEnvio).toBeNull();
      expect(resposta.boleto).toMatchObject({ status: 'GERADO' });
    });

    it('falha inesperada no boleto aparece em `falhas`', async () => {
      const { v } = revistoria('EM_ANALISE');
      ambiente.boleto.processar.mockRejectedValueOnce(new Error('inesperado'));

      const resposta = await ambiente.sujeito.aprovar(v.id);

      expect(resposta.boleto).toBeNull();
      expect(resposta.falhas).toEqual([
        { etapa: 'BOLETO', erro: 'inesperado' },
      ]);
    });

    it('resume o envio à Hinova de quem ganhou', async () => {
      const { v } = revistoria('EM_ANALISE');

      const resposta = await ambiente.sujeito.aprovar(v.id);

      expect(resposta.repetida).toBe(false);
      expect(resposta.hinovaEnvio).toEqual({
        envioId: 1,
        status: 'ENVIADA',
        totalFotos: 1,
        totalInseridas: 1,
        totalFalhas: 0,
      });
      expect(resposta.falhas).toEqual([]);
    });
  });

  describe('gerar boleto manual', () => {
    it('revistoria inexistente → 404', async () => {
      await expect(ambiente.sujeito.gerarBoleto(1)).rejects.toThrow(
        new NotFoundException('Revistoria não encontrada'),
      );
    });

    it('fora de APROVADA → 400, sem chamar o boleto', async () => {
      const { r } = revistoria('EM_ANALISE');

      await expect(ambiente.sujeito.gerarBoleto(r.id)).rejects.toThrow(
        new BadRequestException(
          'Somente revistorias APROVADA podem gerar boleto de reativação',
        ),
      );
      expect(ambiente.boleto.processar).not.toHaveBeenCalled();
    });

    it('APROVADA → delega com origem MANUAL', async () => {
      const { r } = revistoria('APROVADA');

      await ambiente.sujeito.gerarBoleto(r.id, 'dbg');

      expect(ambiente.boleto.processar).toHaveBeenCalledWith(r.id, {
        origem: 'MANUAL',
        debugId: 'dbg',
      });
    });
  });

  describe('PATCH /status e PATCH /finalizar', () => {
    it.each(['APROVADA', 'FINALIZADA'])(
      'revistoria %s não volta para EM_ANALISE: 409 e o status fica',
      async (status) => {
        const { v, r } = revistoria(status);

        await expect(ambiente.sujeito.marcarEmAnalise(v.id)).rejects.toEqual(
          erro409('REVISTORIA_TRANSICAO_INVALIDA'),
        );
        expect(r.status).toBe(status);
      },
    );

    it('repetir PATCH /status com a revistoria EM_ANALISE não grava de novo', async () => {
      const { v, r } = revistoria('EM_ANALISE');
      const antes = r.updatedAt;

      await ambiente.sujeito.marcarEmAnalise(v.id);

      expect(r.updatedAt).toBe(antes);
    });

    it('repetir PATCH /finalizar não grava de novo', async () => {
      const { v, r } = revistoria('FINALIZADA');
      const antes = r.updatedAt;

      const resposta = await ambiente.sujeito.finalizar(v.id);

      expect(resposta.status).toBe('FINALIZADA');
      expect(r.updatedAt).toBe(antes);
    });

    it('finalizar e aprovar ao mesmo tempo: termina FINALIZADA, com no máximo um conjunto de efeitos', async () => {
      const { v, r } = revistoria('EM_ANALISE');

      await Promise.allSettled([
        ambiente.sujeito.finalizar(v.id),
        ambiente.sujeito.aprovar(v.id),
      ]);

      expect(r.status).toBe('FINALIZADA');
      expect(ambiente.boleto.processar.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
    });
  });

  describe('avaliação de foto', () => {
    it.each(['APROVADA', 'FINALIZADA'])(
      'aprovar foto de revistoria %s aprova a foto e NÃO rebaixa a revistoria',
      async (status) => {
        const { r } = revistoria(status);
        const f = ambiente.banco.comFoto({ reinspectionId: r.id });

        const resposta = await ambiente.sujeito.approvePhoto(f.id);

        expect(resposta.photo.status).toBe('APROVADA');
        expect(resposta.reinspection.status).toBe(status);
        expect(r.status).toBe(status);
      },
    );

    it('aprovar as fotos em paralelo depois da aprovação não desfaz a aprovação', async () => {
      const { v, r } = revistoria('EM_ANALISE');
      const fotos = [1, 2, 3].map(() =>
        ambiente.banco.comFoto({ reinspectionId: r.id }),
      );

      await ambiente.sujeito.aprovar(v.id);
      await Promise.all(fotos.map((f) => ambiente.sujeito.approvePhoto(f.id)));

      expect(r.status).toBe('APROVADA');
      expect(fotos.every((f) => f.status === 'APROVADA')).toBe(true);
    });

    it('reprovar foto de revistoria APROVADA reprova a revistoria (reaprovação)', async () => {
      const { r } = revistoria('APROVADA');
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'APROVADA',
      });

      const resposta = await ambiente.sujeito.reprovePhoto(f.id);

      expect(resposta.reinspection.status).toBe('REPROVADA');
      expect(r.status).toBe('REPROVADA');
    });

    it('reprovar foto de revistoria FINALIZADA → 409 e a foto fica como estava', async () => {
      const { r } = revistoria('FINALIZADA');
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'APROVADA',
      });

      await expect(ambiente.sujeito.reprovePhoto(f.id)).rejects.toEqual(
        erro409('REVISTORIA_TRANSICAO_INVALIDA'),
      );
      expect(ambiente.banco.linha('reinspectionPhoto', f.id).status).toBe(
        'APROVADA',
      );
      expect(ambiente.banco.linha('reinspection', r.id).status).toBe(
        'FINALIZADA',
      );
    });

    it('reprovar a segunda foto de revistoria já REPROVADA responde 200', async () => {
      const { r } = revistoria('REPROVADA');
      ambiente.banco.comFoto({ reinspectionId: r.id, status: 'REPROVADA' });
      const outra = ambiente.banco.comFoto({ reinspectionId: r.id });

      const resposta = await ambiente.sujeito.reprovePhoto(outra.id);

      expect(resposta.photo.status).toBe('REPROVADA');
      expect(resposta.reinspection.status).toBe('REPROVADA');
    });

    it('avaliações rodam com a revistoria travada (SELECT ... FOR UPDATE)', async () => {
      const { r } = revistoria('EM_ANALISE');
      const f = ambiente.banco.comFoto({ reinspectionId: r.id });
      const travar = jest.spyOn(ambiente.banco, '$queryRaw');

      await ambiente.sujeito.approvePhoto(f.id);
      await ambiente.sujeito.reprovePhoto(f.id);

      expect(travar).toHaveBeenCalledTimes(2);
      const [sql] = travar.mock.calls[0] as unknown as [string[]];
      expect(sql.join('?')).toContain('FOR UPDATE');
    });
  });

  describe('reenvio de foto reprovada', () => {
    it('dois reenvios simultâneos da mesma foto: um troca a foto e avisa; o outro recebe 400', async () => {
      const { r } = revistoria('REPROVADA');
      const f = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
      });

      const resultados = await Promise.allSettled([
        ambiente.sujeito.resendPhoto(f.id, 'B64-1'),
        ambiente.sujeito.resendPhoto(f.id, 'B64-2'),
      ]);

      const ok = resultados.filter((x) => x.status === 'fulfilled');
      const falhas = resultados.filter((x) => x.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(falhas).toHaveLength(1);
      expect(falhas[0].reason).toEqual(
        new BadRequestException(
          'Somente fotos reprovadas podem ser reenviadas',
        ),
      );
      expect(
        ambiente.mail.sendFotoRecusadaReenviadaEmail,
      ).toHaveBeenCalledTimes(1);
      expect(f.status).toBe('PENDENTE');
      expect(r.status).toBe('EM_ANALISE');
    });

    it('reenvios de fotos diferentes em paralelo (o app faz assim): todos 200, um e-mail por foto', async () => {
      const { r } = revistoria('REPROVADA');
      const fotos = [1, 2, 3].map(() =>
        ambiente.banco.comFoto({ reinspectionId: r.id, status: 'REPROVADA' }),
      );

      const respostas = await Promise.all(
        fotos.map((f) => ambiente.sujeito.resendPhoto(f.id, 'B64')),
      );

      expect(respostas.map((x) => x.reinspectionStatus)).toEqual([
        'EM_ANALISE',
        'EM_ANALISE',
        'EM_ANALISE',
      ]);
      expect(
        ambiente.mail.sendFotoRecusadaReenviadaEmail,
      ).toHaveBeenCalledTimes(3);
    });

    it.each(['APROVADA', 'FINALIZADA'])(
      'revistoria %s com foto reprovada (dado antigo) → 409 e a foto NÃO é trocada',
      async (status) => {
        const { r } = revistoria(status);
        const f = ambiente.banco.comFoto({
          reinspectionId: r.id,
          status: 'REPROVADA',
          url: 'uploads/original.jpg',
        });

        await expect(ambiente.sujeito.resendPhoto(f.id, 'B64')).rejects.toEqual(
          erro409('REVISTORIA_TRANSICAO_INVALIDA'),
        );
        expect(ambiente.banco.linha('reinspectionPhoto', f.id)).toMatchObject({
          status: 'REPROVADA',
          url: 'uploads/original.jpg',
        });
        expect(
          ambiente.mail.sendFotoRecusadaReenviadaEmail,
        ).not.toHaveBeenCalled();
      },
    );

    it('a resposta diz se o aviso por e-mail saiu', async () => {
      const { r } = revistoria('REPROVADA');
      const a = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
      });
      const b = ambiente.banco.comFoto({
        reinspectionId: r.id,
        status: 'REPROVADA',
      });

      const enviada = await ambiente.sujeito.resendPhoto(a.id, 'B64');
      ambiente.mail.sendFotoRecusadaReenviadaEmail.mockRejectedValueOnce(
        new Error('smtp fora'),
      );
      const falhou = await ambiente.sujeito.resendPhoto(b.id, 'B64');

      expect(enviada.notificacao).toBe('ENVIADA');
      expect(falhou.notificacao).toBe('FALHOU');
    });
  });

  describe('create', () => {
    const pedido = (userVehicleId: number, codigoVeiculo?: number) => ({
      userVehicleId,
      vehicleType: ReinspectionVehicleType.MOTOS,
      codigoVeiculo,
    });

    it('dois pedidos simultâneos para o mesmo veículo criam UMA revistoria', async () => {
      const v = veiculo();

      const respostas = await Promise.all([
        ambiente.sujeito.create(pedido(v.id)),
        ambiente.sujeito.create(pedido(v.id)),
        ambiente.sujeito.create(pedido(v.id)),
      ]);

      expect(ambiente.banco.tabelas.reinspection).toHaveLength(1);
      expect(new Set(respostas.map((x) => x.reinspectionId)).size).toBe(1);
      expect(respostas[0]).toEqual({
        reinspectionId: ambiente.banco.tabelas.reinspection[0].id,
        status: 'PENDENTE',
        createdAt: ambiente.banco.tabelas.reinspection[0].createdAt,
      });
    });

    it('veículos diferentes não se travam', async () => {
      const a = veiculo();
      const b = ambiente.banco.comVeiculo();

      await Promise.all([
        ambiente.sujeito.create(pedido(a.id)),
        ambiente.sujeito.create(pedido(b.id)),
      ]);

      expect(ambiente.banco.tabelas.reinspection).toHaveLength(2);
    });

    it('pedido com dados diferentes cria outra revistoria', async () => {
      const v = veiculo();

      await ambiente.sujeito.create(pedido(v.id, 1));
      await ambiente.sujeito.create(pedido(v.id, 2));

      expect(ambiente.banco.tabelas.reinspection).toHaveLength(2);
    });

    it('revistoria vazia antiga (fora da janela) não é reaproveitada', async () => {
      const v = veiculo();
      ambiente.banco.comRevistoria({
        userVehicleId: v.id,
        vehicleType: 'MOTOS',
        createdAt: new Date(Date.now() - 10 * 60_000),
      });

      await ambiente.sujeito.create(pedido(v.id));

      expect(ambiente.banco.tabelas.reinspection).toHaveLength(2);
    });

    it('trava ocupada além do limite de espera → 409, sem criar', async () => {
      const v = veiculo();
      jest
        .spyOn(ambiente.trava, 'tentar')
        .mockResolvedValue({ executou: false });
      jest.useFakeTimers();
      try {
        const criacao = ambiente.sujeito.create(pedido(v.id));
        const esperado = expect(criacao).rejects.toEqual(
          erro409('REVISTORIA_CRIACAO_EM_ANDAMENTO'),
        );
        await jest.runAllTimersAsync();
        await esperado;
      } finally {
        jest.useRealTimers();
      }
      expect(ambiente.banco.tabelas.reinspection).toHaveLength(0);
    });
  });

  describe('submit', () => {
    const prontaParaSubmeter = () => {
      const { r } = revistoria('PENDENTE');
      ambiente.banco.comFoto({ reinspectionId: r.id });
      return r;
    };

    it('submit em dobro, simultâneo: UM e-mail e as duas respostas 200', async () => {
      const r = prontaParaSubmeter();

      const respostas = await Promise.all([
        ambiente.sujeito.submit(r.id),
        ambiente.sujeito.submit(r.id),
      ]);

      expect(ambiente.mail.sendRevistoriaEmail).toHaveBeenCalledTimes(1);
      expect(respostas.map((x) => x.notificacao).sort()).toEqual([
        'EM_ANDAMENTO',
        'ENVIADA',
      ]);
      for (const resposta of respostas) {
        expect(resposta).toMatchObject({
          reinspectionId: r.id,
          status: 'PENDENTE',
          totalPhotos: 1,
        });
      }
    });

    it('submit repetido depois: sem outro e-mail, resposta JA_ENVIADA', async () => {
      const r = prontaParaSubmeter();

      const primeira = await ambiente.sujeito.submit(r.id);
      const repetida = await ambiente.sujeito.submit(r.id);

      expect(ambiente.mail.sendRevistoriaEmail).toHaveBeenCalledTimes(1);
      expect(primeira.notificacao).toBe('ENVIADA');
      expect(repetida.notificacao).toBe('JA_ENVIADA');
    });

    it('e-mail que falha: resposta diz FALHOU e a próxima submissão tenta de novo', async () => {
      const r = prontaParaSubmeter();
      ambiente.mail.sendRevistoriaEmail.mockRejectedValueOnce(
        new Error('smtp fora'),
      );

      const falhou = await ambiente.sujeito.submit(r.id);
      const depois = await ambiente.sujeito.submit(r.id);

      expect(falhou.notificacao).toBe('FALHOU');
      expect(depois.notificacao).toBe('ENVIADA');
      expect(ambiente.mail.sendRevistoriaEmail).toHaveBeenCalledTimes(2);
    });

    it('a marca de submissão é do DONO do veículo, não de quem chamou', async () => {
      const r = prontaParaSubmeter();
      const executar = jest.spyOn(ambiente.idempotencia, 'executar');
      const dono = ambiente.banco.linha(
        'userVehicle',
        r.userVehicleId as number,
      ).userId;

      await ambiente.sujeito.submit(r.id);

      expect(executar.mock.calls[0][0]).toMatchObject({
        userId: dono,
        escopo: 'revistoria.submit',
        chave: `revistoria-${r.id}`,
      });
    });

    it('falha da própria idempotência (banco) não é engolida', async () => {
      const r = prontaParaSubmeter();
      jest
        .spyOn(ambiente.idempotencia, 'executar')
        .mockRejectedValueOnce(new Error('banco fora'));

      await expect(ambiente.sujeito.submit(r.id)).rejects.toThrow('banco fora');
    });
  });
});
