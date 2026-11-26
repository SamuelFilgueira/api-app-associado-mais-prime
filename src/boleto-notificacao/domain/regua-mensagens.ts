import { formatDateBR, formatDateISO } from 'src/shared/date.util';
import {
  mesPorExtenso,
  primeiroNome,
  renderizarMensagem,
  TokensMensagem,
} from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';
import { SgaBoletoPeriodo } from 'src/boleto-notificacao/interfaces/sga-boleto-periodo.interface';
import {
  ModeloDeMensagem,
  TipoMensagem,
} from 'src/boleto-notificacao/domain/regua-tipos';

/**
 * Título e corpo de um grupo (associado × vencimento). Os tokens da régua
 * saem do primeiro boleto do grupo.
 */
export function textosDoGrupo(
  grupo: { vencimento: Date; boletos: SgaBoletoPeriodo[] },
  modelo: ModeloDeMensagem,
): { titulo: string; corpo: string } {
  const primeiroBoleto = grupo.boletos[0];
  const vencimentoBR = formatDateBR(grupo.vencimento);
  const valores: TokensMensagem = {
    nome: primeiroNome(primeiroBoleto?.nomeAssociado),
    placa:
      String(primeiroBoleto?.veiculos?.[0]?.placa ?? '').trim() ||
      'seu veículo',
    mes: mesPorExtenso(primeiroBoleto?.mesReferente),
    data: vencimentoBR.slice(0, 5),
    vencimento: vencimentoBR,
    quantidade: grupo.boletos.length,
  };
  return {
    titulo: renderizarMensagem(modelo.titulo, valores),
    corpo: renderizarMensagem(modelo.corpo, valores),
  };
}

/** Push da régua, no formato que o Expo recebe. */
export interface PushDaRegua {
  to: string;
  title: string;
  body: string;
  data: {
    type: 'internal_route';
    screen: 'financeiro';
    origem: 'boleto_cobranca';
    tipoMensagem: TipoMensagem;
    dataVencimentoOriginal: string;
    quantidadeBoletos: number;
  };
  sound: 'default';
  priority: 'high';
  channelId: string;
  _contentAvailable: true;
  mutableContent: true;
}

export function montarPush(
  destinatario: {
    expoPushToken: string;
    titulo: string;
    corpo: string;
    vencimento: Date;
    boletos: unknown[];
  },
  tipo: TipoMensagem,
): PushDaRegua {
  return {
    to: destinatario.expoPushToken,
    title: destinatario.titulo,
    body: destinatario.corpo,
    data: {
      // Deep-link reaproveitado do fluxo de push por CPF: abre a área financeira do app
      type: 'internal_route',
      screen: 'financeiro',
      origem: 'boleto_cobranca',
      tipoMensagem: tipo,
      dataVencimentoOriginal: formatDateISO(destinatario.vencimento),
      quantidadeBoletos: destinatario.boletos.length,
    },
    sound: 'default',
    priority: 'high',
    channelId: 'alerts_v2',
    _contentAvailable: true,
    mutableContent: true,
  };
}
