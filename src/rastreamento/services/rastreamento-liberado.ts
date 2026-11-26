import { ForbiddenException } from '@nestjs/common';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';

/**
 * O painel pode cortar o rastreamento de um veículo (`cortarRastreamento`).
 * É a ÚNICA recusa por veículo no rastreamento — não há checagem de posse.
 */
export async function garantirRastreamentoLiberado(
  veiculos: VeiculoRastreamentoRepository,
  chassi: string,
): Promise<void> {
  if (await veiculos.rastreamentoCortado(chassi)) {
    throw new ForbiddenException(
      `Rastreamento bloqueado para o veículo com chassi ${chassi}.`,
    );
  }
}
