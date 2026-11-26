import { montarMensagemPush } from 'src/notifications/domain/push-mensagem';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import {
  CenarioDePushEmMassa,
  montarCenarioDePushEmMassa,
  tokenDe,
} from 'src/notifications/testing/cenario-push-massa';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { PUSH_MASSA_QUEUE } from 'src/queue/filas';
import { DomainError, IntegrationError } from 'src/shared/erros/erros';

/**
 * Disparo de marketing por lotes.
 *
 * A garantia que o spec antigo travava continua valendo no desenho novo: com
 * 250 destinatários (lotes de 100, 100 e 50), cada um ganha exatamente UMA
 * linha de histórico, com o próprio token, e a falha de um lote não desloca
 * o histórico dos outros. O que mudou é QUANDO: a rota só cria o disparo e
 * enfileira; o envio é dos jobs de lote, que podem ser repetidos sem mandar
 * push em dobro.
 */
describe('NotificationsService.sendMarketingNotification — disparo por lotes', () => {
  const ADMIN = 9;
  const oferta = { title: 'Oferta', body: 'Corpo' };
  let cenario: CenarioDePushEmMassa;
  let service: NotificationsService;

  const montar = (usuarios: number) => {
    cenario = montarCenarioDePushEmMassa();
    cenario.repo.comUsuarios(usuarios, tokenDe);
    service = new NotificationsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      cenario.marketing,
      {} as never,
    );
  };

  const idsComHistorico = () =>
    cenario.repo.notificacoes.map((n) => n.userId).sort((a, b) => a - b);
  const sequencia = (de: number, ate: number) =>
    Array.from({ length: ate - de + 1 }, (_, i) => de + i);
  const logDoDisparo = (disparoId: number) =>
    cenario.repo.logs.get(
      cenario.repo.disparo(disparoId).marketingAuditLogId as number,
    );

  describe('a rota só cria e enfileira', () => {
    it('250 destinatários: responde na hora com o disparo criado, três lotes na fila e nenhum push enviado', async () => {
      montar(250);

      const resposta = await service.sendMarketingNotification(oferta, ADMIN);

      expect(resposta).toEqual({
        // Campos de sempre: agora, o que se sabe no momento da resposta.
        sentCount: 250,
        skippedCount: 0,
        // Campos novos.
        disparoId: 1,
        estado: 'ENVIANDO',
        totalDestinatarios: 250,
      });
      expect(cenario.gateway.chamadas).toHaveLength(0);
      expect(cenario.repo.notificacoes).toHaveLength(0);
      expect(cenario.repo.entregasDo(1).map((e) => e.estado)).toEqual(
        Array.from({ length: 250 }, () => 'PENDENTE'),
      );
      // Um job por página de 100 entregas, com id determinístico.
      expect(
        cenario.jobsDeLote().map((j) => [j.id, j.dados.deId, j.dados.ateId]),
      ).toEqual([
        ['push-1-1', 1, 100],
        ['push-1-101', 101, 200],
        ['push-1-201', 201, 250],
      ]);
      expect(logDoDisparo(1)).toMatchObject({
        status: 'REQUESTED',
        skippedCount: 0,
      });
    });

    it('usuário com token de formato inválido fica de fora e entra em `skippedCount`', async () => {
      montar(10);
      cenario.repo.usuarios.get(3)!.expoPushToken = 'token-velho';
      cenario.repo.usuarios.get(4)!.acceptsMarketingNotifications = false;
      cenario.repo.usuarios.get(5)!.isActive = false;

      const resposta = await service.sendMarketingNotification(oferta, ADMIN);

      expect(resposta).toMatchObject({ sentCount: 7, skippedCount: 1 });
      expect(cenario.repo.entregasDo(1).map((e) => e.userId)).toEqual([
        1, 2, 6, 7, 8, 9, 10,
      ]);
    });

    it('sem destinatário válido: conclui na hora com zero, sem lote', async () => {
      montar(3);
      for (const usuario of cenario.repo.usuarios.values()) {
        usuario.expoPushToken = 'invalido';
      }

      const resposta = await service.sendMarketingNotification(oferta, ADMIN);

      expect(resposta).toMatchObject({
        sentCount: 0,
        skippedCount: 3,
        estado: 'CONCLUIDO',
      });
      expect(cenario.jobsDeLote()).toHaveLength(0);
      expect(logDoDisparo(resposta.disparoId)).toMatchObject({
        status: 'SENT',
        sentCount: 0,
        skippedCount: 3,
      });
    });

    it('falha ao gravar as entregas: disparo e log ficam como falhos e nada entra na fila', async () => {
      montar(5);
      cenario.repo.criarEntregas = () =>
        Promise.reject(new Error('ECONNRESET: banco fora'));

      await expect(
        service.sendMarketingNotification(oferta, ADMIN),
      ).rejects.toThrow('banco fora');

      expect(cenario.repo.disparo(1).estado).toBe('FALHOU');
      expect(logDoDisparo(1)).toMatchObject({
        status: 'FAILED',
        errorMessage: 'ECONNRESET: banco fora',
      });
      expect(cenario.produtor.jobs).toHaveLength(0);
    });
  });

  describe('envio pelos lotes', () => {
    it('250 destinatários: cada um recebe UM push e UMA linha de histórico, com o próprio token', async () => {
      montar(250);
      await service.sendMarketingNotification(oferta, ADMIN);

      const execucoes = await cenario.executarLotes();

      expect(execucoes.map((e) => e.resultado)).toEqual([
        { enviadas: 100, recusadas: 0, falhas: 0 },
        { enviadas: 100, recusadas: 0, falhas: 0 },
        { enviadas: 50, recusadas: 0, falhas: 0 },
      ]);
      // Um push por destinatário.
      const aceitos = cenario.gateway.aceitosPorToken();
      expect(aceitos.size).toBe(250);
      expect([...aceitos.values()].every((n) => n === 1)).toBe(true);
      expect(cenario.gateway.chamadas[0][0]).toEqual(
        montarMensagemPush(tokenDe(1), 'Oferta', 'Corpo', {
          type: 'marketing',
        }),
      );
      // Uma linha de histórico por destinatário, com o token dele.
      expect(idsComHistorico()).toEqual(sequencia(1, 250));
      for (const linha of cenario.repo.notificacoes) {
        expect(linha.expoPushToken).toBe(tokenDe(linha.userId));
        expect(linha).toMatchObject({ title: 'Oferta', body: 'Corpo' });
      }
      // Cada entrega com o seu ticket; disparo e log fechados com a contagem real.
      for (const entrega of cenario.repo.entregasDo(1)) {
        expect(entrega).toMatchObject({
          estado: 'ENVIADA',
          ticketId: `ticket-${tokenDe(entrega.userId)}`,
          tentativas: 1,
        });
      }
      expect(cenario.repo.disparo(1)).toMatchObject({
        estado: 'CONCLUIDO',
        totalDestinatarios: 250,
        totalEnviadas: 250,
        totalRecusadas: 0,
        totalFalhas: 0,
      });
      expect(logDoDisparo(1)).toMatchObject({
        status: 'SENT',
        sentCount: 250,
        skippedCount: 0,
      });
    });

    it('lote do meio com falha de transporte: os outros seguem e só ele é reenviado, sem duplicar ninguém', async () => {
      montar(250);
      await service.sendMarketingNotification(oferta, ADMIN);
      cenario.gateway.responder = (mensagens, chamada) =>
        chamada === 1
          ? PushGatewayFalso.semResposta(mensagens)
          : PushGatewayFalso.aceitarTudo(mensagens);

      const [primeiro, meio, ultimo] = await cenario.executarLotes();

      // O job do meio FALHA (o BullMQ repete); os outros concluem.
      expect(primeiro.erro).toBeUndefined();
      expect(ultimo.erro).toBeUndefined();
      expect(meio.erro).toBeInstanceOf(IntegrationError);
      expect((meio.erro as IntegrationError).transitoria).toBe(true);
      // O histórico dos outros lotes não se desloca.
      expect(idsComHistorico()).toEqual([
        ...sequencia(1, 100),
        ...sequencia(201, 250),
      ]);
      expect(
        cenario.repo
          .entregasDo(1)
          .filter((e) => e.estado === 'FALHA')
          .map((e) => e.userId),
      ).toEqual(sequencia(101, 200));
      // Com entrega ainda aberta, nem o disparo nem o log fecham.
      expect(cenario.repo.disparo(1).estado).toBe('ENVIANDO');
      expect(logDoDisparo(1)!.status).toBe('REQUESTED');

      // Nova tentativa do MESMO job: manda só os 100 que faltavam.
      const antes = cenario.gateway.totalDeMensagens();
      await cenario.lotes.processar(meio.job.dados);

      expect(cenario.gateway.totalDeMensagens() - antes).toBe(100);
      expect(
        cenario.gateway.chamadas[cenario.gateway.chamadas.length - 1].map(
          (m) => m.to,
        ),
      ).toEqual(sequencia(101, 200).map(tokenDe));
      const aceitos = cenario.gateway.aceitosPorToken();
      expect(aceitos.size).toBe(250);
      expect([...aceitos.values()].every((n) => n === 1)).toBe(true);
      expect(idsComHistorico()).toEqual(sequencia(1, 250));
      expect(cenario.repo.disparo(1)).toMatchObject({
        estado: 'CONCLUIDO',
        totalEnviadas: 250,
        totalFalhas: 0,
      });
      expect(logDoDisparo(1)).toMatchObject({ status: 'SENT', sentCount: 250 });
    });

    it('reexecução do mesmo job não reenvia: nem com o disparo em envio, nem depois de fechado', async () => {
      montar(250);
      await service.sendMarketingNotification(oferta, ADMIN);
      const [primeiro, segundo, terceiro] = cenario.jobsDeLote();

      await cenario.lotes.processar(primeiro.dados);
      expect(cenario.gateway.totalDeMensagens()).toBe(100);

      // Job "stalled" reexecutado com o disparo ainda em envio.
      await expect(cenario.lotes.processar(primeiro.dados)).resolves.toEqual({
        enviadas: 0,
        recusadas: 0,
        falhas: 0,
      });
      expect(cenario.gateway.totalDeMensagens()).toBe(100);

      await cenario.lotes.processar(segundo.dados);
      await cenario.lotes.processar(terceiro.dados);
      expect(cenario.repo.disparo(1).estado).toBe('CONCLUIDO');

      // E depois de fechado.
      await expect(
        cenario.lotes.processar(segundo.dados),
      ).resolves.toMatchObject({ enviadas: 0, ignorado: 'CONCLUIDO' });
      expect(cenario.gateway.totalDeMensagens()).toBe(250);
      expect(idsComHistorico()).toEqual(sequencia(1, 250));
    });

    it('duas execuções do mesmo lote ao mesmo tempo: uma envia, a outra falha para repetir depois', async () => {
      montar(100);
      await service.sendMarketingNotification(oferta, ADMIN);
      const [job] = cenario.jobsDeLote();

      const resultados = await Promise.allSettled([
        cenario.lotes.processar(job.dados),
        cenario.lotes.processar(job.dados),
      ]);

      expect(resultados.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(cenario.gateway.totalDeMensagens()).toBe(100);
      expect(cenario.repo.notificacoes).toHaveLength(100);
    });

    it('banco falha DEPOIS de o push sair: a gravação insiste no lugar, sem mandar o push de novo', async () => {
      montar(100);
      await service.sendMarketingNotification(oferta, ADMIN);
      cenario.repo.gravacoesQueFalham = 2;

      const [execucao] = await cenario.executarLotes();

      expect(execucao.erro).toBeUndefined();
      expect(cenario.gateway.chamadas).toHaveLength(1);
      expect(cenario.repo.notificacoes).toHaveLength(100);
      expect(cenario.repo.disparo(1).estado).toBe('CONCLUIDO');
    });

    it('recusa do Expo: sem histórico e sem novo envio; token morto é apagado, token trocado no meio fica', async () => {
      montar(10);
      await service.sendMarketingNotification(oferta, ADMIN);
      // O usuário 6 reinstalou o app depois da seleção: já tem outro token.
      const tokenNovo = 'ExponentPushToken[novo-do-usuario-6]';
      cenario.repo.usuarios.get(6)!.expoPushToken = tokenNovo;
      cenario.gateway.responder = (mensagens) =>
        mensagens.map((m) => {
          if (m.to === tokenDe(5) || m.to === tokenDe(6)) {
            return {
              status: 'recusado',
              mensagem: 'not a registered push notification recipient',
              detalhe: 'DeviceNotRegistered',
            };
          }
          if (m.to === tokenDe(7)) {
            return {
              status: 'recusado',
              mensagem: 'payload grande',
              detalhe: 'MessageTooBig',
            };
          }
          return { status: 'ok', ticketId: `ticket-${m.to}` };
        });

      const [execucao] = await cenario.executarLotes();

      // Recusa não lança: o job conclui.
      expect(execucao.erro).toBeUndefined();
      expect(execucao.resultado).toEqual({
        enviadas: 7,
        recusadas: 3,
        falhas: 0,
      });
      expect(idsComHistorico()).toEqual([1, 2, 3, 4, 8, 9, 10]);
      expect(
        cenario.repo
          .entregasDo(1)
          .filter((e) => e.estado === 'RECUSADA')
          .map((e) => [e.userId, e.erro]),
      ).toEqual([
        [
          5,
          'DeviceNotRegistered: not a registered push notification recipient',
        ],
        [
          6,
          'DeviceNotRegistered: not a registered push notification recipient',
        ],
        [7, 'MessageTooBig: payload grande'],
      ]);
      // Token morto apagado; o trocado e o recusado por outro motivo ficam.
      expect(cenario.repo.usuarios.get(5)!.expoPushToken).toBeNull();
      expect(cenario.repo.usuarios.get(6)!.expoPushToken).toBe(tokenNovo);
      expect(cenario.repo.usuarios.get(7)!.expoPushToken).toBe(tokenDe(7));
      // Fechou com as contagens reais.
      expect(logDoDisparo(1)).toMatchObject({
        status: 'SENT',
        sentCount: 7,
        skippedCount: 3,
      });

      // Reexecução não tenta de novo os recusados.
      await cenario.lotes.processar(execucao.job.dados);
      expect(cenario.gateway.totalDeMensagens()).toBe(10);
    });

    it('nenhum push aceito: o disparo falha e o log diz por quê', async () => {
      montar(4);
      await service.sendMarketingNotification(oferta, ADMIN);
      cenario.gateway.responder = (mensagens) =>
        mensagens.map(() => ({
          status: 'recusado',
          mensagem: 'credencial inválida',
          detalhe: 'InvalidCredentials',
        }));

      await cenario.executarLotes();

      expect(cenario.repo.disparo(1).estado).toBe('FALHOU');
      expect(logDoDisparo(1)).toMatchObject({
        status: 'FAILED',
        sentCount: 0,
        skippedCount: 4,
        errorMessage:
          'Nenhum push aceito: 4 recusado(s) e 0 com falha de envio.',
      });
      expect(cenario.repo.notificacoes).toHaveLength(0);
    });

    it('usuário apagado depois da seleção: o lote não cai por causa dele', async () => {
      montar(5);
      await service.sendMarketingNotification(oferta, ADMIN);
      cenario.repo.usuarios.delete(3);

      const [execucao] = await cenario.executarLotes();

      expect(execucao.erro).toBeUndefined();
      expect(idsComHistorico()).toEqual([1, 2, 4, 5]);
      expect(cenario.repo.disparo(1).estado).toBe('CONCLUIDO');
    });

    it('ao fechar, agenda a consulta de recibos (uma vez)', async () => {
      montar(150);
      await service.sendMarketingNotification(oferta, ADMIN);

      await cenario.executarLotes();

      const recibos = cenario.produtor.da(PUSH_MASSA_QUEUE, 'push-recibos');
      expect(recibos).toHaveLength(1);
      expect(recibos[0]).toMatchObject({
        id: 'push-recibos-1-1',
        dados: { disparoId: 1, passada: 1 },
        opcoes: { atrasoMs: 15 * 60_000 },
      });
    });
  });

  describe('uma execução por vez', () => {
    it('duplo clique (dois pedidos iguais ao mesmo tempo): UM disparo; o segundo recebe 409', async () => {
      montar(120);

      const resultados = await Promise.allSettled([
        service.sendMarketingNotification(oferta, ADMIN),
        service.sendMarketingNotification(oferta, ADMIN),
      ]);

      expect(resultados.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const recusado = resultados.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(recusado?.reason).toBeInstanceOf(DomainError);
      expect(recusado?.reason).toMatchObject({
        code: 'DISPARO_EM_ANDAMENTO',
        status: 409,
      });
      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.repo.logs.size).toBe(1);
      expect(cenario.repo.entregas).toHaveLength(120);
    });

    it('segundo clique logo depois do primeiro: devolve o MESMO disparo, sem novo log e sem novos lotes', async () => {
      montar(120);
      const primeira = await service.sendMarketingNotification(oferta, ADMIN);

      const segunda = await service.sendMarketingNotification(oferta, ADMIN);

      expect(segunda).toEqual({ ...primeira, repetido: true });
      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.repo.logs.size).toBe(1);
      expect(cenario.jobsDeLote()).toHaveLength(2);

      // Nem depois de concluído (dentro da janela de repetição).
      await cenario.executarLotes();
      const terceira = await service.sendMarketingNotification(oferta, ADMIN);
      expect(terceira).toMatchObject({
        disparoId: primeira.disparoId,
        estado: 'CONCLUIDO',
        repetido: true,
      });
      expect(cenario.gateway.totalDeMensagens()).toBe(120);
    });

    it('o mesmo texto, passada a janela de repetição, é um disparo novo', async () => {
      montar(3);
      const primeira = await service.sendMarketingNotification(oferta, ADMIN);
      await cenario.executarLotes();
      cenario.repo.disparo(primeira.disparoId).criadoEm = new Date(
        Date.now() - 10 * 60_000,
      );

      const segunda = await service.sendMarketingNotification(oferta, ADMIN);

      expect(segunda.disparoId).not.toBe(primeira.disparoId);
      expect(segunda.repetido).toBeUndefined();
    });

    it('conteúdo diferente é outro disparo', async () => {
      montar(3);
      const a = await service.sendMarketingNotification(oferta, ADMIN);
      const b = await service.sendMarketingNotification(
        { ...oferta, data: { type: 'external_link', url: 'https://x' } },
        ADMIN,
      );

      expect(b.disparoId).not.toBe(a.disparoId);
      expect(cenario.repo.disparos).toHaveLength(2);
    });

    it('disparo que falhou não barra a nova tentativa do painel', async () => {
      montar(3);
      const criarEntregas = cenario.repo.criarEntregas.bind(cenario.repo);
      cenario.repo.criarEntregas = () => Promise.reject(new Error('banco'));
      await expect(
        service.sendMarketingNotification(oferta, ADMIN),
      ).rejects.toThrow();
      cenario.repo.criarEntregas = criarEntregas;

      const nova = await service.sendMarketingNotification(oferta, ADMIN);

      expect(nova).toMatchObject({ estado: 'ENVIANDO', sentCount: 3 });
      expect(nova.repetido).toBeUndefined();
    });

    it('fila fora ao enfileirar: o disparo fica em envio e o novo pedido recoloca os lotes, sem outro disparo', async () => {
      montar(150);
      cenario.produtor.erro = new Error('Redis fora');
      await expect(
        service.sendMarketingNotification(oferta, ADMIN),
      ).rejects.toThrow('Redis fora');
      // As entregas já estavam completas: nada se perde, nada foi enviado.
      expect(cenario.repo.disparo(1).estado).toBe('ENVIANDO');
      expect(logDoDisparo(1)!.status).toBe('REQUESTED');

      cenario.produtor.erro = null;
      const nova = await service.sendMarketingNotification(oferta, ADMIN);

      expect(nova).toMatchObject({ disparoId: 1, repetido: true });
      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.jobsDeLote()).toHaveLength(2);
    });

    it('Idempotency-Key: a repetição recebe a primeira resposta e nada roda de novo', async () => {
      montar(5);
      const dto = { ...oferta };
      const contexto = { adminUserId: ADMIN, chaveDeIdempotencia: 'clique-1' };

      const primeira = await service.dispararMarketing(dto, contexto);
      await cenario.executarLotes();
      // Fora da janela de repetição: só a chave explica a mesma resposta.
      cenario.repo.disparo(1).criadoEm = new Date(Date.now() - 3_600_000);
      const repetida = await service.dispararMarketing(dto, contexto);

      expect(repetida).toEqual(primeira);
      expect(cenario.repo.disparos).toHaveLength(1);
    });

    it('com `agendarPara` a rota só agenda', async () => {
      montar(5);
      const dto = { ...oferta, agendarPara: '2027-01-01T12:00:00.000Z' };

      await service.dispararMarketing(dto, { adminUserId: ADMIN });

      expect(cenario.agendamentos).toEqual([dto]);
      expect(cenario.repo.disparos).toHaveLength(0);
    });
  });
});
