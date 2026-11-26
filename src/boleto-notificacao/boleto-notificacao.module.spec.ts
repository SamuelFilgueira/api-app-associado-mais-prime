import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/database/prisma.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { BoletoNotificacaoModule } from 'src/boleto-notificacao/boleto-notificacao.module';
import { BoletoNotificacaoAdminController } from 'src/boleto-notificacao/controllers/boleto-notificacao-admin.controller';
import { BoletoNotificacaoProcessor } from 'src/boleto-notificacao/processors/boleto-notificacao.processor';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { ReguaEnvioService } from 'src/boleto-notificacao/services/regua-envio.service';
import { ReguaMetricaService } from 'src/boleto-notificacao/services/regua-metrica.service';

jest.mock('src/config/tenant.config', () => ({
  TENANT: { baseNames: ['MAIS_PRIME'], defaultBase: 'MAIS_PRIME' },
  isTenantBase: (v: unknown) => v === 'MAIS_PRIME',
}));

/** O que no app vem dos módulos globais (banco, filas, consistência). */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: TravaService, useValue: {} },
    { provide: ProdutorDeFilas, useValue: {} },
    { provide: FilaDeMortosService, useValue: {} },
    { provide: getQueueToken(BOLETO_NOTIFICACAO_QUEUE), useValue: {} },
  ],
  exports: [
    PrismaService,
    TravaService,
    ProdutorDeFilas,
    FilaDeMortosService,
    getQueueToken(BOLETO_NOTIFICACAO_QUEUE),
  ],
})
class GlobaisDeTeste {}

@Module({
  providers: [{ provide: SgaAuthService, useValue: {} }],
  exports: [SgaAuthService],
})
class HinovaDeTeste {}

/**
 * Injeção de dependência do módulo: todo provider novo resolve só com o que
 * o módulo importa (Hinova, Expo) mais os módulos globais do app.
 */
describe('BoletoNotificacaoModule — injeção de dependência', () => {
  it('monta controller, fachada, casos de uso e processor; o push sai pela porta PushGateway', async () => {
    const modulo = await Test.createTestingModule({
      imports: [GlobaisDeTeste, BoletoNotificacaoModule],
    })
      .overrideModule(HinovaModule)
      .useModule(HinovaDeTeste)
      .compile();

    for (const classe of [
      BoletoNotificacaoAdminController,
      BoletoNotificacaoService,
      BoletoNotificacaoReceiptsService,
      BoletoNotificacaoProcessor,
      ReguaEnvioService,
      ReguaMetricaService,
    ]) {
      expect(modulo.get(classe, { strict: false })).toBeInstanceOf(classe);
    }
    // Um único adaptador do Expo no processo, atrás da porta.
    expect(modulo.get(PushGateway, { strict: false })).toBeInstanceOf(
      ExpoPushClient,
    );

    await modulo.close();
  });
});
