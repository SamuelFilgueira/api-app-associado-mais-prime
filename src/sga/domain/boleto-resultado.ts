import type { ReinspectionBoletoStatus } from '@prisma/client';
import type { BoletoReativacaoOrigem } from 'src/sga/domain/boleto-geracao';

/** Recorte da revistoria (e do veículo) usado na geração do boleto. */
export interface RevistoriaParaBoleto {
  id: number;
  status: string;
  codigoVeiculo: number | null;
  boletoStatus: ReinspectionBoletoStatus;
  boletoTentativas: number;
  boletoNossoNumero: string | null;
  boletoOrigem?: string | null;
  boletoUltimaTentativaEm: Date | null;
  boletoProximaTentativaEm?: Date | null;
  boletoRetryInicioEm: Date | null;
  userVehicle: {
    id: number;
    chassi: string;
    plate: string | null;
    user: { cpf: string | null; baseOrigin: string | null } | null;
  };
}

/** O que a tentativa carrega do lease até a gravação do desfecho. */
export interface TentativaDeBoleto {
  revistoria: RevistoriaParaBoleto;
  origem: BoletoReativacaoOrigem;
  debugId?: string;
  /** Dono do lease reivindicado para esta tentativa. */
  dono: string;
  numero: number;
  agora: Date;
  inicioDaJanela: Date;
}

/** O que uma tentativa de gerar o boleto devolve a quem a pediu. */
export interface BoletoReativacaoResultado {
  reinspectionId: number;
  status: ReinspectionBoletoStatus;
  /**
   * PULADO: nada foi feito — o boleto já estava gerado, outra tentativa está
   * em andamento ou a revistoria não está num estado que permita gerar.
   */
  pulado: boolean;
  /** Boleto já existia no SGA (criado à mão) e foi adotado em vez de cadastrado. */
  adotado: boolean;
  nossoNumero: string | null;
  linkBoleto: string | null;
  tentativas: number;
  proximaTentativaEm: Date | null;
  erro: string | null;
  suriEnviada: boolean;
  emailEnviado: boolean;
}

/** Boleto que a tentativa conseguiu: cadastrado, adotado ou retomado. */
export interface BoletoPronto {
  nossoNumero: string | null;
  linkBoleto: string | null;
  suriEnviada: boolean;
  adotado: boolean;
  /** Algo que ficou para a equipe fazer à mão; vai no e-mail da cobrança. */
  pendencia?: string | null;
}

/** Resultado com os campos ausentes no valor neutro. */
export function resultadoDoBoleto(
  reinspectionId: number,
  parcial: Partial<BoletoReativacaoResultado> & {
    status: ReinspectionBoletoStatus;
  },
): BoletoReativacaoResultado {
  return {
    reinspectionId,
    pulado: false,
    adotado: false,
    nossoNumero: null,
    linkBoleto: null,
    tentativas: 0,
    proximaTentativaEm: null,
    erro: null,
    suriEnviada: false,
    emailEnviado: false,
    ...parcial,
  };
}
