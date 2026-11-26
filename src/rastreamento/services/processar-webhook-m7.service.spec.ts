import { metricas } from 'src/infra/observability/metricas';
import { WEBHOOK_QUEUE } from 'src/queue/filas';
import { extrairEventoM7 } from 'src/rastreamento/domain/evento-m7';
import {
  EventoEmProcessamentoError,
  ProcessarWebhookM7Service,
} from 'src/rastreamento/services/processar-webhook-m7.service';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import {
  montarRastreamento,
  prepararCredenciaisDeTeste,
} from 'src/rastreamento/testing/montar-rastreamento';
import { ehErroTransitorio } from 'src/shared/erros/erros';

/**
 * Webhook da M7 idempotente e sem erro engolido. Fixtures sintéticas, só com
 * a forma do payload da M7.
 */
describe('ProcessarWebhookM7Service', () => {
  const CHASSI = '9BWZZZ377VT004251';

  let banco: BancoRastreamentoEmMemoria;
  let notifications: { dispararNotificacaoVeiculoWebhook: jest.Mock };
  let webhook: ProcessarWebhookM7Service;
  let restaurarAmbiente: () => void;

  const eventoDeIgnicao = (mudancas: Record<string, unknown> = {}) => ({
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

  const descartados = async () => {
    const { values } = await metricas.filaProcessados.get();
    return (
      values.find(
        (v) =>
          v.labels.queue === WEBHOOK_QUEUE &&
          v.labels.name === 'm7-event' &&
          v.labels.resultado === 'descartado',
      )?.value ?? 0
    );
  };

  function montar(trava?: unknown): void {
    webhook = montarRastreamento({
      banco,
      m7: {
        processarWebhook: (payload: unknown) => ({
          sucesso: true,
          mensagem: 'Webhook processado com sucesso',
          dados: { palyload: payload },
        }),
      },
      logica: {},
      softruck: {},
      notifications,
      trava,
    }).webhook;
  }

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    banco = new BancoRastreamentoEmMemoria();
    notifications = {
      dispararNotificacaoVeiculoWebhook: jest
        .fn()
        .mockResolvedValue({ sent: 1, skipped: 0 }),
    };
    const dono = banco.comUsuario({ notificacaoIgnicao: true });
    banco.comVeiculo({ userId: dono.id, chassi: CHASSI });
    montar();
  });

  afterEach(() => restaurarAmbiente());

  it('primeira entrega: grava uma linha com o hash, aciona o push e marca como processado', async () => {
    const retorno = await webhook.executar(eventoDeIgnicao());

    expect(retorno).toMatchObject({ sucesso: true, resultado: 'processado' });
    expect(banco.eventos).toHaveLength(1);
    expect(banco.eventos[0]).toMatchObject({
      chassi: CHASSI,
      eventoHash: extrairEventoM7(eventoDeIgnicao()).hash,
      processed: true,
    });
    expect(
      notifications.dispararNotificacaoVeiculoWebhook,
    ).toHaveBeenCalledWith(CHASSI, 32, 'Ignição Ligada', {
      chaveDoEvento: extrairEventoM7(eventoDeIgnicao()).hash,
    });
  });

  it('reentrega do mesmo evento: uma linha e um push', async () => {
    await webhook.executar(eventoDeIgnicao());
    const segunda = await webhook.executar(eventoDeIgnicao());
    // A M7 entrega o mesmo evento uma vez por canal.
    const terceira = await webhook.executar(
      eventoDeIgnicao({ scope: 'cliente' }),
    );

    expect(segunda.resultado).toBe('duplicado');
    expect(terceira.resultado).toBe('duplicado');
    expect(banco.eventos).toHaveLength(1);
    expect(
      notifications.dispararNotificacaoVeiculoWebhook,
    ).toHaveBeenCalledTimes(1);
  });

  it('erro de banco na gravação faz o job falhar (erro transitório → retry)', async () => {
    const falha = Object.assign(new Error('pool esgotado'), { code: 'P2024' });
    banco.falharNaProxima('vehicleWebhookEvent', falha);

    await expect(webhook.executar(eventoDeIgnicao())).rejects.toBe(falha);

    expect(ehErroTransitorio(falha)).toBe(true);
    expect(
      notifications.dispararNotificacaoVeiculoWebhook,
    ).not.toHaveBeenCalled();
  });

  it('falha ao acionar o push propaga; a nova tentativa não grava outra linha e manda o push', async () => {
    const falha = new Error('fila de alertas indisponível');
    notifications.dispararNotificacaoVeiculoWebhook.mockRejectedValueOnce(
      falha,
    );

    await expect(webhook.executar(eventoDeIgnicao())).rejects.toBe(falha);
    expect(banco.eventos).toHaveLength(1);
    expect(banco.eventos[0].processed).toBe(false);

    const retry = await webhook.executar(eventoDeIgnicao());

    expect(retry.resultado).toBe('processado');
    expect(banco.eventos).toHaveLength(1);
    expect(banco.eventos[0].processed).toBe(true);
    // As duas tentativas levam a MESMA chave: o lado das notificações não
    // repete o push de quem já foi avisado.
    const chaves =
      notifications.dispararNotificacaoVeiculoWebhook.mock.calls.map(
        (chamada) => (chamada[3] as { chaveDoEvento: string }).chaveDoEvento,
      );
    expect(chaves).toHaveLength(2);
    expect(chaves[0]).toBe(chaves[1]);
  });

  it('evento mais antigo que o último processado é descartado, com métrica e sem push', async () => {
    await webhook.executar(
      eventoDeIgnicao({
        codigo: '900002',
        enviado_em: '2026-08-31T13:10:00.000Z',
      }),
    );
    const antes = await descartados();

    const atrasado = await webhook.executar(
      eventoDeIgnicao({
        codigo: '900001',
        enviado_em: '2026-08-31T13:00:00.000Z',
      }),
    );

    expect(atrasado.resultado).toBe('descartado');
    expect(await descartados()).toBe(antes + 1);
    expect(
      notifications.dispararNotificacaoVeiculoWebhook,
    ).toHaveBeenCalledTimes(1);
    // A reentrega do evento descartado continua descartada.
    await expect(
      webhook.executar(
        eventoDeIgnicao({
          codigo: '900001',
          enviado_em: '2026-08-31T13:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({ resultado: 'descartado' });
    expect(
      notifications.dispararNotificacaoVeiculoWebhook,
    ).toHaveBeenCalledTimes(1);
  });

  it('a ordem vale por veículo e por tipo: outro tipo ou outro chassi não é descartado', async () => {
    const outroDono = banco.comUsuario({ notificacaoIgnicao: true });
    banco.comVeiculo({ userId: outroDono.id, chassi: 'OUTROCHASSI0000001' });
    await webhook.executar(
      eventoDeIgnicao({ enviado_em: '2026-08-31T13:10:00.000Z' }),
    );

    const outroTipo = await webhook.executar(
      eventoDeIgnicao({
        codigo: '900003',
        evento: 'Violação de Âncora',
        tipoevento: 16,
        enviado_em: '2026-08-31T13:00:00.000Z',
      }),
    );
    const outroChassi = await webhook.executar(
      eventoDeIgnicao({
        codigo: '900004',
        chassi: 'OUTROCHASSI0000001',
        enviado_em: '2026-08-31T13:00:00.000Z',
      }),
    );

    expect(outroTipo.resultado).toBe('processado');
    expect(outroChassi.resultado).toBe('processado');
  });

  it('evento sem data de envio não é descartado (na dúvida, o alerta sai)', async () => {
    await webhook.executar(eventoDeIgnicao());

    const semData = await webhook.executar(
      eventoDeIgnicao({ codigo: '900005', enviado_em: undefined }),
    );

    expect(semData.resultado).toBe('processado');
  });

  it('payload sem chassi: nada gravado, nada notificado', async () => {
    const retorno = await webhook.executar({ teste: 'ping' });

    expect(retorno.resultado).toBe('ignorado');
    expect(banco.eventos).toHaveLength(0);
    expect(
      notifications.dispararNotificacaoVeiculoWebhook,
    ).not.toHaveBeenCalled();
  });

  it('outra execução com a trava do mesmo evento: o job falha para tentar depois', async () => {
    montar({ tentar: () => Promise.resolve({ executou: false }) });

    const erro = await webhook
      .executar(eventoDeIgnicao())
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(EventoEmProcessamentoError);
    expect(ehErroTransitorio(erro)).toBe(true);
    expect(banco.eventos).toHaveLength(0);
  });

  describe('decisão do push lida do VEÍCULO', () => {
    it('alerta desligado no veículo (ligado só no usuário): evento gravado, push não sai', async () => {
      banco.veiculos[0].notificacaoIgnicao = false;

      const retorno = await webhook.executar(eventoDeIgnicao());

      expect(retorno.resultado).toBe('processado');
      expect(banco.eventos).toHaveLength(1);
      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).not.toHaveBeenCalled();
    });

    it('veículo ainda null: vale o valor do usuário', async () => {
      banco.usuarios[0].notificacaoIgnicao = false;

      await webhook.executar(eventoDeIgnicao());

      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).not.toHaveBeenCalled();
    });

    it('dois veículos do mesmo usuário: o evento do carro com alerta desligado não gera push', async () => {
      const dono = banco.usuarios[0];
      banco.veiculos[0].notificacaoIgnicao = true;
      banco.comVeiculo({
        userId: dono.id,
        chassi: 'CARROB00000000001',
        notificacaoIgnicao: false,
      });

      await webhook.executar(
        eventoDeIgnicao({ codigo: '900010', chassi: 'CARROB00000000001' }),
      );
      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).not.toHaveBeenCalled();

      await webhook.executar(eventoDeIgnicao({ codigo: '900011' }));
      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).toHaveBeenCalledTimes(1);
    });

    it('veículo ou dono inativo não recebe', async () => {
      banco.veiculos[0].isActive = false;

      await webhook.executar(eventoDeIgnicao());

      expect(
        notifications.dispararNotificacaoVeiculoWebhook,
      ).not.toHaveBeenCalled();
    });
  });
});
