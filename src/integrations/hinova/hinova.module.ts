import { Module } from '@nestjs/common';
import { SgaAuthService } from './sga-auth.service';

/**
 * Integração Hinova (SGA). Único ponto que conhece a base URL e a autenticação
 * (`token_usuario` por base) da API Hinova. Módulos de domínio que falam com o
 * SGA importam este módulo e injetam `SgaAuthService`.
 */
@Module({
  providers: [SgaAuthService],
  exports: [SgaAuthService],
})
export class HinovaModule {}
