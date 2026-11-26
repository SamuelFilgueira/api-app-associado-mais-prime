import { InternalServerErrorException } from '@nestjs/common';
import { metricas } from 'src/infra/observability/metricas';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import { ehErroHttp } from 'src/integrations/core/erro-http';

/**
 * Rotas do app cujo contrato (antigo, e que não muda) devolve o erro do SGA
 * com status de sucesso. Cada ocorrência conta em
 * `vendor_erro_como_sucesso_total` — é por ali que se enxerga o SGA
 * falhando, já que o status HTTP da API não mostra.
 */
export type RotaComErroComoSucesso =
  | 'sga/associado'
  | 'sga/veiculos'
  | 'sga/veiculos-info'
  | 'sga/boleto/listar';

export interface RespostaComStatus {
  status: number;
  statusText?: string;
  data: unknown;
}

export function contarErroComoSucesso(rota: RotaComErroComoSucesso): void {
  metricas.vendorErro200.inc({ vendor: 'hinova', rota });
}

/** Corpo de erro do SGA que volta ao app como veio (ou o corpo padrão). */
export function corpoDeErroDoSga(
  rota: RotaComErroComoSucesso,
  response: RespostaComStatus,
): unknown {
  contarErroComoSucesso(rota);
  return (
    response.data || {
      mensagem: 'Erro desconhecido',
      error: [response.statusText],
    }
  );
}

/**
 * Exceção numa consulta ao SGA: base não resolvida é falha explícita (422
 * `BASE_NAO_RESOLVIDA`); erro HTTP com corpo volta ao app como veio; o resto
 * vira 500 com a mensagem da rota.
 */
export function erroDaConsultaAoSga(
  rota: RotaComErroComoSucesso,
  error: unknown,
  mensagem: string,
): unknown {
  if (error instanceof BaseNaoResolvidaError) throw error;
  if (ehErroHttp(error) && error.response?.data) {
    contarErroComoSucesso(rota);
    return error.response.data;
  }
  throw new InternalServerErrorException(mensagem);
}
