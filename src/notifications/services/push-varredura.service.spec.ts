import { metricas } from 'src/infra/observability/metricas';
import { MAX_TENTATIVAS_DA_ENTREGA } from 'src/notifications/domain/push-disparo';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { PushVarreduraService } from 'src/notifications/services/push-varredura.service';
import {
  CenarioDePushEmMassa,
  montarCenarioDePushEmMassa,
  tokenDe,
} from 'src/notifications/testing/cenario-push-massa';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';

/**
 * Varredura periódica: o que antes só era reconciliado no boot (e fechava o
 * `SENDING` órfão como falho, sem reenviar) agora é retomado a cada minuto.
 */
describe('PushVarreduraService', () => {
  const MINUTO = 60_000;
  let cenario: CenarioDePushEmMassa;
  let agendamento: { reconciliarPendentes: jest.Mock };
  let varredura: PushVarreduraService;

  /** Roda a varredura e exige que ela tenha rodado (não barrada pela trava). */
  const varrer = async (agora?: Date) => {
    const resultado = await varredura.executar(agora);
    if (!resultado) throw new Error('a varredura não rodou');
    return resultado;
  };
  const idadeDoEnvio = async () =>
    (await metricas.marketingEmEnvioIdade.get()).values[0]?.value;
  const daqui = (ms: number) => new Date(Date.now() + ms);
  const logDo = (disparoId: number) =>
    cenario.repo.logs.get(
      cenario.repo.disparo(disparoId).marketingAuditLogId as number,
    );

  beforeEach(() => {
    cenario = montarCenarioDePushEmMassa();
    cenario.repo.comUsuarios(250, tokenDe);
    agendamento = {
      reconciliarPendentes: jest
        .fn()
        .mockResolvedValue({ agendados: 2, perdidos: 1 }),
    };
    varredura = new PushVarreduraService(
      cenario.repo.comoRepositorio(),
      cenario.disparos,
      cenario.lotes,
      agendamento as unknown as MarketingAgendamentoService,
      cenario.trava.comoTrava(),
    );
  });

  it('nada parado: só reconcilia os agendamentos e publica idade 0', async () => {
    const r = await varredura.executar();

    expect(r).toEqual({
      agendados: 2,
      perdidos: 1,
      logsOrfaos: 0,
      retomados: 0,
      encerrados: 0,
      idadeDoMaisAntigoSeg: 0,
    });
    expect(await idadeDoEnvio()).toBe(0);
  });

  it('disparo em envio com batimento recente não é mexido; a idade dele é publicada', async () => {
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    const jobsAntes = cenario.produtor.jobs.length;

    const r = await varrer(daqui(5 * MINUTO));

    expect(r).toMatchObject({ retomados: 0, encerrados: 0 });
    expect(cenario.produtor.jobs).toHaveLength(jobsAntes);
    expect(r.idadeDoMaisAntigoSeg).toBeGreaterThanOrEqual(299);
    expect(await idadeDoEnvio()).toBe(r.idadeDoMaisAntigoSeg);
  });

  it('em ENVIANDO sem batimento há mais de 15 min: recoloca na fila só as páginas com entrega aberta, com id próprio', async () => {
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    // O lote do meio esgotou as tentativas (Expo fora) e o job morreu.
    cenario.gateway.responder = (mensagens, chamada) =>
      chamada === 1
        ? PushGatewayFalso.semResposta(mensagens)
        : PushGatewayFalso.aceitarTudo(mensagens);
    await cenario.executarLotes();
    expect(cenario.repo.disparo(1).estado).toBe('ENVIANDO');

    const agora = daqui(16 * MINUTO);
    const r = await varredura.executar(agora);

    expect(r).toMatchObject({ retomados: 1, encerrados: 0 });
    const sufixo = Math.floor(agora.getTime() / 1000);
    const retomada = cenario.jobsDeLote().slice(3);
    // Mesma página do job original (101–200), id diferente.
    expect(retomada.map((j) => [j.id, j.dados.deId, j.dados.ateId])).toEqual([
      [`push-1-101-r${sufixo}`, 101, 200],
    ]);

    // O job da retomada envia só os 100 que faltavam e o disparo fecha.
    cenario.gateway.responder = PushGatewayFalso.aceitarTudo;
    await cenario.executarLotes();
    const aceitos = cenario.gateway.aceitosPorToken();
    expect(aceitos.size).toBe(250);
    expect([...aceitos.values()].every((n) => n === 1)).toBe(true);
    expect(cenario.repo.notificacoes).toHaveLength(250);
    expect(logDo(1)).toMatchObject({ status: 'SENT', sentCount: 250 });
  });

  it('duas varreduras sobre o mesmo disparo parado: só uma retoma', async () => {
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    const agora = daqui(16 * MINUTO);

    const [a, b] = await Promise.all([
      varredura.executar(agora),
      varredura.executar(agora),
    ]);

    // A trava deixa uma rodada por vez; a outra nem começa.
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    // E, mesmo em sequência, o batimento já marcado impede a segunda retomada.
    const depois = await varredura.executar(agora);
    expect(depois).toMatchObject({ retomados: 0 });
    expect(cenario.jobsDeLote()).toHaveLength(6);
  });

  it('em ENVIANDO sem entrega aberta (caiu entre o último lote e o fechamento): fecha o disparo e o log', async () => {
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    for (const entrega of cenario.repo.entregasDo(1)) {
      Object.assign(entrega, { estado: 'ENVIADA', ticketId: 'x' });
    }

    const r = await varredura.executar(daqui(16 * MINUTO));

    expect(r).toMatchObject({ retomados: 0, encerrados: 1 });
    expect(cenario.repo.disparo(1).estado).toBe('CONCLUIDO');
    expect(logDo(1)).toMatchObject({ status: 'SENT', sentCount: 250 });
  });

  it('entrega que já falhou no limite de tentativas não é retomada: o disparo fecha com a falha contada', async () => {
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    for (const entrega of cenario.repo.entregasDo(1)) {
      Object.assign(
        entrega,
        entrega.userId <= 200
          ? { estado: 'ENVIADA', ticketId: 'x' }
          : { estado: 'FALHA', tentativas: MAX_TENTATIVAS_DA_ENTREGA },
      );
    }

    await varredura.executar(daqui(16 * MINUTO));

    expect(cenario.repo.disparo(1)).toMatchObject({
      estado: 'CONCLUIDO',
      totalEnviadas: 200,
      totalFalhas: 50,
    });
    expect(logDo(1)).toMatchObject({
      status: 'SENT',
      sentCount: 200,
      skippedCount: 50,
    });
  });

  it('disparo vencido (mais de 6 h): o que não saiu não sai mais, e fecha', async () => {
    await cenario.marketing.dispararAgora({ title: 'T', body: 'B' }, 9);
    const [primeiro] = cenario.jobsDeLote();
    await cenario.lotes.processar(primeiro.dados);
    const jobsAntes = cenario.jobsDeLote().length;

    const r = await varredura.executar(daqui(7 * 60 * MINUTO));

    expect(r).toMatchObject({ encerrados: 1, retomados: 0 });
    expect(cenario.jobsDeLote()).toHaveLength(jobsAntes);
    expect(cenario.repo.disparo(1)).toMatchObject({
      estado: 'CONCLUIDO',
      totalEnviadas: 100,
      totalFalhas: 150,
    });
    expect(
      cenario.repo.entregasDo(1).filter((e) => e.estado === 'FALHA')[0].erro,
    ).toBe('Disparo expirado antes do envio');
    // Os jobs antigos que ainda estiverem na fila não enviam mais nada.
    await cenario.executarLotes();
    expect(cenario.gateway.totalDeMensagens()).toBe(100);
  });

  it('marketing parado em CRIADO (processo morreu criando as entregas): termina a criação e enfileira', async () => {
    const disparo = await cenario.repo.criarDisparo({
      tipo: 'MARKETING',
      titulo: 'T',
      corpo: 'B',
      dados: { type: 'marketing' },
      marketingAuditLogId: cenario.repo.comLog({ id: 50, status: 'SENDING' })
        .id,
    });
    // Só parte das entregas tinha sido gravada.
    await cenario.repo.criarEntregas(
      disparo.id,
      [1, 2, 3].map((id) => ({ userId: id, expoPushToken: tokenDe(id) })),
    );

    const r = await varredura.executar(daqui(16 * MINUTO));

    expect(r).toMatchObject({ retomados: 1 });
    expect(cenario.repo.disparo(1).estado).toBe('ENVIANDO');
    expect(cenario.repo.entregasDo(1)).toHaveLength(250);
    expect(cenario.jobsDeLote()).toHaveLength(3);
  });

  it('planilha parada em CRIADO: a lista se perdeu com a requisição — falha, sem enviar nada', async () => {
    cenario.repo.comLog({ id: 60, status: 'REQUESTED' });
    await cenario.repo.criarDisparo({
      tipo: 'SITUACAO_CADASTRO',
      titulo: 'T',
      corpo: 'B',
      dados: {},
      marketingAuditLogId: 60,
    });

    const r = await varredura.executar(daqui(16 * MINUTO));

    expect(r).toMatchObject({ encerrados: 1 });
    expect(cenario.repo.disparo(1).estado).toBe('FALHOU');
    expect(cenario.repo.logs.get(60)).toMatchObject({
      status: 'FAILED',
      errorMessage: 'Criação do disparo interrompida; nenhum push foi enviado.',
    });
    expect(cenario.produtor.jobs).toHaveLength(0);
  });

  it('log aberto sem disparo há mais de 15 min (inclusive `SENDING` de antes do envio por lotes): fecha como falho, sem reenviar', async () => {
    const antigo = new Date(Date.now() - 20 * MINUTO);
    cenario.repo.agora = () => antigo;
    cenario.repo.comLog({ id: 70, status: 'SENDING' });
    cenario.repo.comLog({ id: 71, status: 'REQUESTED' });
    cenario.repo.agora = () => new Date();
    cenario.repo.comLog({ id: 72, status: 'REQUESTED' }); // recém-criado
    cenario.repo.comLog({ id: 73, status: 'SCHEDULED' }); // agendado: não é órfão

    const r = await varrer();

    expect(r.logsOrfaos).toBe(2);
    expect(cenario.repo.logs.get(70)).toMatchObject({
      status: 'FAILED',
      errorMessage:
        'Envio interrompido antes de concluir; não foi reenviado para evitar duplicidade.',
    });
    expect(cenario.repo.logs.get(71)?.status).toBe('FAILED');
    expect(cenario.repo.logs.get(72)?.status).toBe('REQUESTED');
    expect(cenario.repo.logs.get(73)?.status).toBe('SCHEDULED');
    expect(cenario.repo.disparos).toHaveLength(0);
  });

  it('um disparo que não retoma não impede os outros; a rodada FALHA no fim dizendo qual ficou', async () => {
    await cenario.marketing.dispararAgora({ title: 'A', body: 'B' }, 9);
    await cenario.marketing.dispararAgora({ title: 'C', body: 'D' }, 9);
    const blocoDeEntregas = cenario.repo.blocoDeEntregas.bind(cenario.repo);
    cenario.repo.blocoDeEntregas = (disparoId, aposId, limite) =>
      disparoId === 1
        ? Promise.reject(new Error('ECONNRESET: banco fora'))
        : blocoDeEntregas(disparoId, aposId, limite);

    await expect(varredura.executar(daqui(16 * MINUTO))).rejects.toThrow(
      'Varredura do push: 1 disparo(s) não retomado(s) — #1: ECONNRESET: banco fora',
    );

    // O disparo 2 foi retomado mesmo assim.
    expect(
      cenario
        .jobsDeLote()
        .filter((j) => j.id.includes('-r'))
        .map((j) => j.dados.disparoId),
    ).toEqual([2, 2, 2]);
  });
});
