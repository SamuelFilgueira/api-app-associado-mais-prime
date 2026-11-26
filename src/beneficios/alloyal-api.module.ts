import { Module } from '@nestjs/common';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { AlloyalCashbackService } from 'src/beneficios/services/alloyal-cashback.service';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { AlloyalCuponsService } from 'src/beneficios/services/alloyal-cupons.service';
import { AlloyalSessaoService } from 'src/beneficios/services/alloyal-sessao.service';
import { AlloyalUsuariosService } from 'src/beneficios/services/alloyal-usuarios.service';
import { AlloyalModule } from 'src/integrations/alloyal/alloyal.module';

/**
 * Clube de vantagens (Alloyal).
 *
 * `AlloyalModule` traz a porta `AlloyalGateway` (client do vendor);
 * `CacheService` vem do `CacheModule` global. Exporta só o
 * `AlloyalCategoriesCacheService`, usado pelo painel de parceiros diretos.
 */
@Module({
  imports: [AlloyalModule],
  controllers: [AlloyalApiController],
  providers: [
    AlloyalSessaoService,
    AlloyalCatalogoService,
    AlloyalCashbackService,
    AlloyalUsuariosService,
    AlloyalCuponsService,
    AlloyalCategoriesCacheService,
  ],
  exports: [AlloyalCategoriesCacheService],
})
export class AlloyalApiModule {}
