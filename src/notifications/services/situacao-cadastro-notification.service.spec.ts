import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/prisma.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';
import {
  CenarioDePushEmMassa,
  montarCenarioDePushEmMassa,
  tokenDe,
} from 'src/notifications/testing/cenario-push-massa';
import { DomainError } from 'src/shared/erros/erros';

describe('SituacaoCadastroNotificationService', () => {
  const ADMIN = 9;
  // CPFs válidos (dígitos verificadores corretos), um por usuário.
  const CPFS = [
    '52998224725',
    '01234567890',
    '11144477735',
    '39053344705',
    '15350946056',
  ];

  let cenario: CenarioDePushEmMassa;
  let usuarios: Array<{
    id: number;
    cpf: string;
    isActive: boolean;
    expoPushToken: string | null;
  }>;
  let service: SituacaoCadastroNotificationService;

  beforeEach(() => {
    cenario = montarCenarioDePushEmMassa();
    usuarios = CPFS.map((cpf, i) => ({
      id: i + 1,
      cpf,
      isActive: true,
      expoPushToken: tokenDe(i + 1),
    }));
    cenario.repo.comUsuarios(usuarios.length, tokenDe);
    const prisma = {
      user: {
        findMany: jest.fn(({ where }: { where: { cpf: { in: string[] } } }) =>
          Promise.resolve(usuarios.filter((u) => where.cpf.in.includes(u.cpf))),
        ),
      },
    };
    service = new SituacaoCadastroNotificationService(
      prisma as unknown as PrismaService,
      cenario.gateway,
      cenario.auditoria.comoServico(),
      cenario.disparos,
      cenario.trava.comoTrava(),
      cenario.idempotencia.comoServico(),
    );
  });

  const gerarPlanilha = async (
    linhas: Array<Array<string | number>>,
  ): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Relatorio');
    linhas.forEach((linha) => sheet.addRow(linha));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  const pedido = async (cpfs: Array<string | number> = CPFS) => ({
    arquivo: await gerarPlanilha([['CPF'], ...cpfs.map((cpf) => [cpf])]),
    title: 'Sua situaÃ§Ã£o mudou',
    body: 'Regularize o cadastro',
  });

  describe('dispararPorPlanilha', () => {
    it('cria o disparo com uma entrega por destinatário, enfileira e responde sem enviar', async () => {
      usuarios[1].isActive = false; // inativo
      usuarios[2].expoPushToken = null; // sem token
      const arquivo = await pedido([...CPFS, '71428793860', 'abc', CPFS[0]]);

      const resposta = await service.dispararPorPlanilha(arquivo, {
        adminUserId: ADMIN,
      });

      expect(resposta).toEqual({
        // Campos de sempre: o que se sabe na hora da resposta.
        sentCount: 3,
        skippedCount: 3,
        resumo: {
          totalLinhasPlanilha: 8,
          cpfsValidos: 6,
          cpfsInvalidos: ['abc'],
          cpfsDuplicadosRemovidos: 1,
          cpfsNaoEncontrados: ['71428793860'],
          cpfsInativos: [CPFS[1]],
          cpfsSemToken: [CPFS[2]],
          // A falha de envio só é conhecida depois da resposta.
          cpfsComFalhaEnvio: [],
        },
        // Campos novos.
        disparoId: 1,
        estado: 'ENVIANDO',
      });
      expect(cenario.gateway.chamadas).toHaveLength(0);
      expect(cenario.repo.disparo(1)).toMatchObject({
        tipo: 'SITUACAO_CADASTRO',
        // Acentuação corrigida, e o destino padrão é a tela de financeiro.
        titulo: 'Sua situação mudou',
        corpo: 'Regularize o cadastro',
        dados: { type: 'internal_route', screen: 'financeiro' },
        totalDestinatarios: 3,
      });
      expect(cenario.repo.entregasDo(1).map((e) => e.userId)).toEqual([
        1, 4, 5,
      ]);
      expect(cenario.jobsDeLote().map((j) => j.id)).toEqual(['push-1-1']);
      const log = cenario.repo.logs.get(
        cenario.repo.disparo(1).marketingAuditLogId as number,
      );
      expect(log).toMatchObject({ status: 'REQUESTED', skippedCount: 3 });
    });

    it('o envio é do lote: um push e uma linha de histórico por destinatário; o log fecha com a contagem real', async () => {
      usuarios[1].isActive = false;
      await service.dispararPorPlanilha(await pedido(), { adminUserId: ADMIN });
      cenario.gateway.responder = (mensagens) =>
        mensagens.map((m) =>
          m.to === tokenDe(4)
            ? {
                status: 'recusado',
                mensagem: 'grande',
                detalhe: 'MessageTooBig',
              }
            : { status: 'ok', ticketId: `ticket-${m.to}` },
        );

      await cenario.executarLotes();

      expect(cenario.repo.notificacoes.map((n) => n.userId)).toEqual([1, 3, 5]);
      const log = cenario.repo.logs.get(
        cenario.repo.disparo(1).marketingAuditLogId as number,
      );
      // 1 inativo (seleção) + 1 recusado pelo Expo (envio).
      expect(log).toMatchObject({
        status: 'SENT',
        sentCount: 3,
        skippedCount: 2,
      });
    });

    it('a mesma planilha com o mesmo texto, enviada de novo em seguida, é o MESMO disparo', async () => {
      const primeira = await service.dispararPorPlanilha(await pedido(), {
        adminUserId: ADMIN,
      });

      const segunda = await service.dispararPorPlanilha(await pedido(), {
        adminUserId: ADMIN,
      });

      expect(segunda).toEqual({ ...primeira, repetido: true });
      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.repo.logs.size).toBe(1);
    });

    it('dois envios iguais ao mesmo tempo: UM disparo; o outro recebe o mesmo disparo ou 409', async () => {
      const resultados = await Promise.allSettled([
        service.dispararPorPlanilha(await pedido(), { adminUserId: ADMIN }),
        service.dispararPorPlanilha(await pedido(), { adminUserId: ADMIN }),
      ]);

      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.repo.logs.size).toBe(1);
      expect(cenario.repo.entregas).toHaveLength(5);
      // Quem chegou com a criação em curso leva 409; quem chegou logo depois
      // recebe o disparo que já existe. Nunca um segundo disparo.
      for (const resultado of resultados) {
        if (resultado.status === 'fulfilled') {
          expect(resultado.value.disparoId).toBe(1);
        } else {
          expect(resultado.reason).toBeInstanceOf(DomainError);
          expect((resultado.reason as DomainError).status).toBe(409);
        }
      }
      expect(resultados.some((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('o mesmo texto para OUTRA lista de CPFs é outro disparo', async () => {
      await service.dispararPorPlanilha(await pedido(CPFS.slice(0, 3)), {
        adminUserId: ADMIN,
      });
      const outra = await service.dispararPorPlanilha(
        await pedido(CPFS.slice(2)),
        { adminUserId: ADMIN },
      );

      expect(outra.repetido).toBeUndefined();
      expect(cenario.repo.disparos).toHaveLength(2);
    });

    it('planilha recusada: 400 e o pedido fica no histórico como falho, sem disparo', async () => {
      const arquivo = {
        ...(await pedido()),
        arquivo: Buffer.from('isto nao e um excel'),
      };

      await expect(
        service.dispararPorPlanilha(arquivo, { adminUserId: ADMIN }),
      ).rejects.toThrow(BadRequestException);

      expect(cenario.repo.disparos).toHaveLength(0);
      expect([...cenario.repo.logs.values()]).toEqual([
        expect.objectContaining({
          status: 'FAILED',
          errorMessage:
            'Arquivo inválido. Envie uma planilha Excel no formato .xlsx',
        }),
      ]);
    });

    it('`data` inválido: 400 antes de qualquer registro', async () => {
      await expect(
        service.dispararPorPlanilha(
          { ...(await pedido()), data: '{invalido' },
          { adminUserId: ADMIN },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(cenario.repo.logs.size).toBe(0);
    });

    it('nenhum CPF da planilha é destinatário: conclui com zero', async () => {
      for (const usuario of usuarios) usuario.isActive = false;

      const resposta = await service.dispararPorPlanilha(await pedido(), {
        adminUserId: ADMIN,
      });

      expect(resposta).toMatchObject({
        sentCount: 0,
        skippedCount: 5,
        estado: 'CONCLUIDO',
      });
      expect(cenario.jobsDeLote()).toHaveLength(0);
    });

    it('Idempotency-Key: a repetição devolve a primeira resposta', async () => {
      const contexto = { adminUserId: ADMIN, chaveDeIdempotencia: 'envio-1' };
      const primeira = await service.dispararPorPlanilha(
        await pedido(),
        contexto,
      );
      cenario.repo.disparo(1).criadoEm = new Date(Date.now() - 3_600_000);
      await cenario.executarLotes();

      const repetida = await service.dispararPorPlanilha(
        await pedido(),
        contexto,
      );

      expect(repetida).toEqual(primeira);
      expect(cenario.repo.disparos).toHaveLength(1);
    });
  });

  describe('parseDataPayload', () => {
    it('sem data, o padrão leva para a tela de financeiro do app', () => {
      expect(service.parseDataPayload(undefined)).toEqual({
        type: 'internal_route',
        screen: 'financeiro',
      });
      expect(service.parseDataPayload('')).toEqual({
        type: 'internal_route',
        screen: 'financeiro',
      });
    });

    it('parseia JSON válido e preenche type padrão', () => {
      // screen presente sem type → internal_route
      expect(service.parseDataPayload('{"screen":"Boletos"}')).toEqual({
        type: 'internal_route',
        screen: 'Boletos',
      });

      // sem screen e sem type → situacao_cadastro
      expect(service.parseDataPayload('{"campaignId":"abc"}')).toEqual({
        type: 'situacao_cadastro',
        campaignId: 'abc',
      });

      expect(
        service.parseDataPayload(
          '{"type":"internal_route","screen":"Boletos"}',
        ),
      ).toEqual({ type: 'internal_route', screen: 'Boletos' });
    });

    it('corrige mojibake nos valores string do payload', () => {
      expect(service.parseDataPayload('{"screen":"SituaÃ§Ã£o"}')).toEqual({
        type: 'internal_route',
        screen: 'Situação',
      });
    });

    it('lança BadRequest para JSON inválido ou não-objeto', () => {
      expect(() => service.parseDataPayload('{invalido')).toThrow(
        BadRequestException,
      );
      expect(() => service.parseDataPayload('[1,2]')).toThrow(
        BadRequestException,
      );
      expect(() => service.parseDataPayload('"texto"')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('corrigirTextoUtf8', () => {
    it('corrige texto com mojibake latin1 → utf8', () => {
      expect(service.corrigirTextoUtf8('AtualizaÃ§Ã£o de cadastro')).toBe(
        'Atualização de cadastro',
      );
      expect(service.corrigirTextoUtf8('SituaÃ§Ã£o alterada')).toBe(
        'Situação alterada',
      );
      expect(
        service.corrigirTextoUtf8('Sua situaÃ§Ã£o Ã© InadimplÃªncia'),
      ).toBe('Sua situação é Inadimplência');
    });

    it('não altera texto já correto', () => {
      expect(service.corrigirTextoUtf8('Atualização de cadastro')).toBe(
        'Atualização de cadastro',
      );
      expect(service.corrigirTextoUtf8('Situação: ATIVO')).toBe(
        'Situação: ATIVO',
      );
      expect(service.corrigirTextoUtf8('SÃO PAULO')).toBe('SÃO PAULO');
      expect(service.corrigirTextoUtf8('Boleto vence hoje')).toBe(
        'Boleto vence hoje',
      );
      expect(service.corrigirTextoUtf8('')).toBe('');
    });

    it('corrige mojibake vindo de cp1252 (aspas curvas e travessão)', () => {
      // "não" em utf8 lido como cp1252: e3 -> ã, mas 0x83 vira ƒ (cp1252)
      expect(service.corrigirTextoUtf8('nÃ£o â€” atenÃ§Ã£o')).toBe(
        'não — atenção',
      );
    });
  });
});
