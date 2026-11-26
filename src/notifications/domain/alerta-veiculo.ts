import type { DadosDoPush } from 'src/notifications/domain/push-mensagem';

/** Eventos de rastreamento que viram alerta para o associado. */
export type TipoDeAlertaDeVeiculo = 'ignicao_ligada' | 'ancora_violada';

/** Códigos de `tipoevento` do webhook da M7. */
const TIPO_EVENTO_IGNICAO_LIGADA = 32;
const TIPO_EVENTO_ANCORA_VIOLADA = 16;

/**
 * Decide se o evento do rastreador gera alerta. Vale o código (`tipoevento`)
 * ou o texto do evento, que a M7 manda com e sem acento. Ignição tem
 * precedência quando os dois casam.
 */
export function classificarEventoDeVeiculo(
  tipoevento: number | null,
  evento: string | null,
): TipoDeAlertaDeVeiculo | null {
  const texto = evento?.toLowerCase() ?? '';

  if (
    tipoevento === TIPO_EVENTO_IGNICAO_LIGADA ||
    texto.includes('igniçao ligada') ||
    texto.includes('ignição ligada')
  ) {
    return 'ignicao_ligada';
  }
  if (
    tipoevento === TIPO_EVENTO_ANCORA_VIOLADA ||
    texto.includes('violação de ancora') ||
    texto.includes('violacao de ancora')
  ) {
    return 'ancora_violada';
  }
  return null;
}

export interface AlertaDeVeiculo {
  title: string;
  body: string;
  data: DadosDoPush;
}

/** Texto e carga do alerta. Sem placa, o veículo é citado pelo chassi. */
export function montarAlertaDeVeiculo(
  tipo: TipoDeAlertaDeVeiculo,
  veiculo: { chassi: string; plate?: string | null },
): AlertaDeVeiculo {
  const rotulo = veiculo.plate
    ? `placa ${veiculo.plate}`
    : `chassi ${veiculo.chassi}`;
  const plate = veiculo.plate ?? undefined;

  if (tipo === 'ignicao_ligada') {
    return {
      title: 'Ignição Ligada 🔑',
      body: `A ignição do seu veículo (${rotulo}) foi ligada.`,
      data: {
        chassi: veiculo.chassi,
        plate,
        ignition: 'on',
        eventType: 'ignition_on',
      },
    };
  }
  return {
    title: 'Violação de Âncora ⚠️',
    body: `Violação de âncora detectada no seu veículo (${rotulo}).`,
    data: { chassi: veiculo.chassi, plate, eventType: 'ancora_violation' },
  };
}

/**
 * Id do job do alerta. Só existe quando quem chama informa a chave do evento
 * (id do webhook): aí o reprocessamento do mesmo evento não gera outro push.
 * O BullMQ não aceita `:` no id.
 */
export function jobIdDoAlerta(
  chaveDoEvento: string | undefined,
  userId: number,
): string | undefined {
  const chave = chaveDoEvento?.trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return chave ? `alerta-${chave}-${userId}` : undefined;
}
