import { Module } from '@nestjs/common';
import { AlloyalHttp } from 'src/integrations/alloyal/alloyal-http';
import { AlloyalClient } from 'src/integrations/alloyal/alloyal.client';
import { AlloyalGateway } from 'src/integrations/alloyal/alloyal.gateway';

/**
 * Integração Alloyal (clube de vantagens). Os módulos de domínio importam
 * este módulo e injetam a porta `AlloyalGateway` — nunca o axios.
 *
 * `AlloyalHttp` (transporte) é interno. `TenantCredentialsRegistry` vem do
 * `SharedModule` (global).
 */
@Module({
  providers: [
    AlloyalHttp,
    AlloyalClient,
    { provide: AlloyalGateway, useExisting: AlloyalClient },
  ],
  exports: [AlloyalGateway, AlloyalClient],
})
export class AlloyalModule {}
