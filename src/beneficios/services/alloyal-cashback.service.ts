import { Injectable } from '@nestjs/common';
import { mapearExtratoDeCashback } from 'src/beneficios/domain/alloyal-cashback';
import { AlloyalCashbackTransferRequestDto } from 'src/beneficios/dto/alloyal-cashback-transfer-request.dto';
import { AlloyalCashbackRecordsResponseDto } from 'src/beneficios/dto/alloyal-cashback.dto';
import { BaseOrigin } from 'src/config/tenant.config';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';

/**
 * Cashback do associado na Alloyal: extrato (saldo e lançamentos) e pedido
 * de resgate por PIX. Dado do usuário — nunca entra em cache.
 */
@Injectable()
export class AlloyalCashbackService {
  constructor(private readonly alloyal: AlloyalGateway) {}

  async extrato(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<AlloyalCashbackRecordsResponseDto> {
    return mapearExtratoDeCashback(
      await this.alloyal.consultarCashback(base, sessao),
    );
  }

  /** Resgate do saldo disponível para a chave PIX do CPF. */
  solicitarResgate(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    pedido: AlloyalCashbackTransferRequestDto,
  ): Promise<void> {
    return this.alloyal.solicitarResgateDeCashback(base, sessao, pedido);
  }
}
