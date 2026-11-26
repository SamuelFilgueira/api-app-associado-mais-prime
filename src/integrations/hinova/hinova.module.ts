import { Module } from '@nestjs/common';
import { HinovaClient } from './hinova.client';
import { SgaAuthService } from './sga-auth.service';

/**
 * Integração Hinova (SGA). Único ponto que conhece a base URL e a autenticação
 * (`token_usuario` por base) da API Hinova. Módulos de domínio que falam com o
 * SGA importam este módulo e injetam:
 *
 * - `HinovaClient`: as leituras repetidas pelo app (associado, boletos e
 *   produtos por veículo), com cache;
 * - `SgaAuthService`: as demais chamadas, autenticadas, com rotação de token
 *   de base, disjuntor e sessão compartilhada entre os processos.
 */
@Module({
  providers: [SgaAuthService, HinovaClient],
  exports: [SgaAuthService, HinovaClient],
})
export class HinovaModule {}
