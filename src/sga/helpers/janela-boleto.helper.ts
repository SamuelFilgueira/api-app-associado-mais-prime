import { formatDateBR } from 'src/shared/date.util';

/**
 * Janela de vencimento (hoje ± 45 dias) usada nas consultas de
 * `/listar/boleto-associado-veiculo` do SGA — antes duplicada em
 * `BoletoService` e `BoletoVerificacaoProcessor`.
 */
export function janelaVencimentoBoleto(): {
  dataInicialStr: string;
  dataFinalStr: string;
} {
  const now = new Date();
  const dataInicial = new Date(now);
  dataInicial.setDate(now.getDate() - 45);
  const dataFinal = new Date(now);
  dataFinal.setDate(dataFinal.getDate() + 45);

  return {
    dataInicialStr: formatDateBR(dataInicial),
    dataFinalStr: formatDateBR(dataFinal),
  };
}
