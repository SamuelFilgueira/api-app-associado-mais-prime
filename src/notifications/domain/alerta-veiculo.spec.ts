import {
  classificarEventoDeVeiculo,
  jobIdDoAlerta,
  montarAlertaDeVeiculo,
} from 'src/notifications/domain/alerta-veiculo';
import {
  mascararTokenPush,
  montarMensagemPush,
} from 'src/notifications/domain/push-mensagem';

describe('alerta de veículo — regras puras', () => {
  describe('classificarEventoDeVeiculo', () => {
    it.each([
      [32, null],
      [null, 'Ignição Ligada'],
      [null, 'IGNIÇAO LIGADA'],
      [5, 'evento: ignição ligada (bateria ok)'],
    ])('ignição ligada: tipoevento=%s evento=%s', (tipoevento, evento) => {
      expect(classificarEventoDeVeiculo(tipoevento, evento)).toBe(
        'ignicao_ligada',
      );
    });

    it.each([
      [16, null],
      [null, 'Violação de Ancora'],
      [null, 'violacao de ancora'],
    ])('âncora violada: tipoevento=%s evento=%s', (tipoevento, evento) => {
      expect(classificarEventoDeVeiculo(tipoevento, evento)).toBe(
        'ancora_violada',
      );
    });

    it('ignição tem precedência quando os dois casam', () => {
      expect(classificarEventoDeVeiculo(32, 'violação de ancora')).toBe(
        'ignicao_ligada',
      );
    });

    it('qualquer outro evento não gera alerta', () => {
      expect(classificarEventoDeVeiculo(99, 'Ignição desligada')).toBeNull();
      expect(classificarEventoDeVeiculo(null, null)).toBeNull();
    });
  });

  describe('montarAlertaDeVeiculo', () => {
    it('ignição: cita a placa e leva `ignition: on` (é o que liga a preferência do usuário)', () => {
      expect(
        montarAlertaDeVeiculo('ignicao_ligada', {
          chassi: '9BW123',
          plate: 'ABC1D23',
        }),
      ).toEqual({
        title: 'Ignição Ligada 🔑',
        body: 'A ignição do seu veículo (placa ABC1D23) foi ligada.',
        data: {
          chassi: '9BW123',
          plate: 'ABC1D23',
          ignition: 'on',
          eventType: 'ignition_on',
        },
      });
    });

    it('âncora sem placa: cita o chassi', () => {
      expect(
        montarAlertaDeVeiculo('ancora_violada', {
          chassi: '9BW123',
          plate: null,
        }),
      ).toEqual({
        title: 'Violação de Âncora ⚠️',
        body: 'Violação de âncora detectada no seu veículo (chassi 9BW123).',
        data: {
          chassi: '9BW123',
          plate: undefined,
          eventType: 'ancora_violation',
        },
      });
    });
  });

  it('jobIdDoAlerta: só existe com a chave do evento, e sem `:`', () => {
    expect(jobIdDoAlerta(undefined, 5)).toBeUndefined();
    expect(jobIdDoAlerta('  ', 5)).toBeUndefined();
    expect(jobIdDoAlerta('webhook:m7:123', 5)).toBe('alerta-webhook_m7_123-5');
  });

  it('montarMensagemPush: formato que o app espera', () => {
    expect(montarMensagemPush('TOKEN', 'T', 'B', { a: 1 })).toEqual({
      to: 'TOKEN',
      title: 'T',
      body: 'B',
      data: { a: 1 },
      sound: 'default',
      priority: 'high',
      channelId: 'alerts_v2',
      _contentAvailable: true,
      mutableContent: true,
    });
  });

  it('mascararTokenPush nunca devolve o token inteiro', () => {
    expect(mascararTokenPush(null)).toBe('ausente');
    expect(mascararTokenPush('curto')).toBe('curto');
    expect(mascararTokenPush('ExponentPushToken[abcdefghijklmnop]')).toBe(
      'ExponentPush...nop]',
    );
  });
});
