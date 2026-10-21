import { Module } from '@nestjs/common';
import { AlloyalApiModule } from 'src/beneficios/alloyal-api.module';
import { DirectPartnersAdminController } from 'src/direct-partners/controllers/direct-partners-admin.controller';
import { DirectPartnersAppController } from 'src/direct-partners/controllers/direct-partners-app.controller';
import { DirectPartnersRepository } from 'src/direct-partners/repositories/direct-partners.repository';
import { DirectPartnerRedemptionsService } from 'src/direct-partners/services/direct-partner-redemptions.service';
import { DirectPartnersService } from 'src/direct-partners/services/direct-partners.service';

/**
 * Parceiros diretos do Clube de Vantagens (fora da rede Alloyal).
 * `AlloyalApiModule` fornece o cache de categorias por base usado nas
 * opções do formulário do painel (§5.0).
 */
@Module({
  imports: [AlloyalApiModule],
  controllers: [DirectPartnersAdminController, DirectPartnersAppController],
  providers: [
    DirectPartnersRepository,
    DirectPartnersService,
    DirectPartnerRedemptionsService,
  ],
})
export class DirectPartnersModule {}
