import { Module } from '@nestjs/common';
import { AssociadoSorteAdminController } from 'src/associado-sorte/controllers/associado-sorte-admin.controller';
import { AssociadoSorteAppController } from 'src/associado-sorte/controllers/associado-sorte-app.controller';
import { SorteCicloProcessor } from 'src/associado-sorte/processors/sorte-ciclo.processor';
import { sorteRedisProvider } from 'src/associado-sorte/providers/sorte-redis.provider';
import { SorteConfigRepository } from 'src/associado-sorte/repositories/sorte-config.repository';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteAleatorioService } from 'src/associado-sorte/services/sorte-aleatorio.service';
import { SorteAppService } from 'src/associado-sorte/services/sorte-app.service';
import { SorteApuracaoService } from 'src/associado-sorte/services/sorte-apuracao.service';
import { SorteCicloService } from 'src/associado-sorte/services/sorte-ciclo.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteDashboardService } from 'src/associado-sorte/services/sorte-dashboard.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { SorteParticipacaoService } from 'src/associado-sorte/services/sorte-participacao.service';
import { SortePremiosService } from 'src/associado-sorte/services/sorte-premios.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { SorteResgateService } from 'src/associado-sorte/services/sorte-resgate.service';
import { SorteRodadasService } from 'src/associado-sorte/services/sorte-rodadas.service';
import { SorteCampanhasRepository } from 'src/associado-sorte/repositories/sorte-campanhas.repository';
import { SorteInscricoesRepository } from 'src/associado-sorte/repositories/sorte-inscricoes.repository';
import { SorteNotificacoesAdminRepository } from 'src/associado-sorte/repositories/sorte-notificacoes-admin.repository';
import { SorteRaspadasRepository } from 'src/associado-sorte/repositories/sorte-raspadas.repository';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteInscricaoService } from 'src/associado-sorte/services/sorte-inscricao.service';
import { SorteLembreteRaspadaService } from 'src/associado-sorte/services/sorte-lembrete-raspada.service';
import { SorteLojaService } from 'src/associado-sorte/services/sorte-loja.service';
import { SorteNotificacoesAdminService } from 'src/associado-sorte/services/sorte-notificacoes-admin.service';
import { SorteRaspadinhaService } from 'src/associado-sorte/services/sorte-raspadinha.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { BeneficiosVeiculoModule } from 'src/sga/beneficios-veiculo/beneficios-veiculo.module';

/**
 * Associado da Sorte — promoção gamificada (v2: raspadinha com momentos
 * premiados, Loja da Sorte, inscrição pelo produto do SGA). Docs:
 * `docs/ASSOCIADO_DA_SORTE.md`.
 *
 * Isolamento: fala com o resto do backend pelo `NotificationsModule` (push),
 * pelo `HinovaModule` + `BeneficiosVeiculoModule` (inscrição no SGA) e pela
 * leitura da tabela `user` (nome, CPF, `isActive`, token de push). Prisma,
 * fila, e-mail e upload vêm dos módulos globais.
 */
@Module({
  imports: [NotificationsModule, HinovaModule, BeneficiosVeiculoModule],
  controllers: [AssociadoSorteAdminController, AssociadoSorteAppController],
  providers: [
    sorteRedisProvider,
    // Dados
    SorteUnidadeTrabalho,
    SorteConfigRepository,
    SorteCreditosRepository,
    SortePremiosRepository,
    SorteRodadasRepository,
    SorteGanhadoresRepository,
    SorteCampanhasRepository,
    SorteRaspadasRepository,
    SorteInscricoesRepository,
    SorteNotificacoesAdminRepository,
    // Regras
    SorteAleatorioService,
    SorteRateLimitService,
    SorteConfigService,
    SorteAcessoService,
    SorteCreditosService,
    SorteTentativaService,
    SorteInscricaoService,
    SorteCampanhaService,
    SorteRaspadinhaService,
    SorteNotificacoesAdminService,
    SorteLojaService,
    SorteLembreteRaspadaService,
    SortePremiosService,
    SorteRodadasService,
    SorteParticipacaoService,
    SorteResgateService,
    SorteApuracaoService,
    SorteGanhadoresService,
    SorteNotificacoesService,
    SorteAppService,
    SorteDashboardService,
    // Job periódico
    SorteCicloService,
    SorteCicloProcessor,
  ],
})
export class AssociadoSorteModule {}
