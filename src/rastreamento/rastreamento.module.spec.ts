import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { PdfRenderer } from 'src/infra/pdf/pdf-renderer';
import { TravaService } from 'src/infra/redis/trava.service';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { RastreamentoController } from 'src/rastreamento/controllers/rastreamento.controller';
import { M7AuthService } from 'src/rastreamento/m7/services/m7-auth.service';
import { WebhookProcessor } from 'src/rastreamento/processors/webhook.processor';
import {
  PROVEDORES_DE_RASTREAMENTO,
  ProvedorDeRastreamento,
} from 'src/rastreamento/providers/rastreamento-provider.interface';
import { RastreamentoModule } from 'src/rastreamento/rastreamento.module';
import { ConsultarPosicaoService } from 'src/rastreamento/services/consultar-posicao.service';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';
import { TokenResolverService } from 'src/shared/token-resolver.service';

/**
 * O que os módulos GLOBAIS da aplicação exportam e o rastreamento usa
 * (`DatabaseModule`, `SharedModule`, `CacheModule`, `PdfModule`,
 * `ConsistenciaModule`, `QueueModule`). Lista explícita, sem auto-mock: se o
 * rastreamento passar a depender de algo que nenhum módulo global entrega, a
 * compilação abaixo falha — como falharia o boot.
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: CacheService, useValue: {} },
    { provide: VendorSessionStore, useValue: VendorSessionStore.emMemoria() },
    { provide: TravaService, useValue: {} },
    { provide: PdfRenderer, useValue: {} },
    { provide: FilaDeMortosService, useValue: {} },
    { provide: getQueueToken(WEBHOOK_QUEUE), useValue: {} },
    TenantCredentialsRegistry,
    TokenResolverService,
  ],
  exports: [
    PrismaService,
    CacheService,
    VendorSessionStore,
    TravaService,
    PdfRenderer,
    FilaDeMortosService,
    getQueueToken(WEBHOOK_QUEUE),
    TenantCredentialsRegistry,
    TokenResolverService,
  ],
})
class GlobaisDeTeste {}

@Module({
  providers: [{ provide: NotificationsService, useValue: {} }],
  exports: [NotificationsService],
})
class NotificacoesDeTeste {}

/**
 * Montagem do módulo pelo Nest: os casos de uso, a fachada, o controller e o
 * registro de provedores resolvem as dependências de verdade.
 */
describe('RastreamentoModule — montagem', () => {
  let modulo: TestingModule;

  beforeAll(async () => {
    modulo = await Test.createTestingModule({
      imports: [GlobaisDeTeste, RastreamentoModule],
    })
      .overrideModule(NotificationsModule)
      .useModule(NotificacoesDeTeste)
      .compile();
  });

  afterAll(async () => {
    await modulo.close();
  });

  it('a fachada, o controller e o processor são instanciados pelo Nest', () => {
    expect(modulo.get(RastreamentoService)).toBeInstanceOf(RastreamentoService);
    expect(modulo.get(RastreamentoController)).toBeInstanceOf(
      RastreamentoController,
    );
    expect(modulo.get(WebhookProcessor)).toBeInstanceOf(WebhookProcessor);
  });

  it('o registro traz os três provedores, na ordem de desempate', () => {
    const provedores = modulo.get<ProvedorDeRastreamento[]>(
      PROVEDORES_DE_RASTREAMENTO,
    );

    expect(provedores.map((p) => p.nome)).toEqual(['logica', 'm7', 'softruck']);
    for (const provedor of provedores) {
      expect(typeof provedor.estaConfigurado).toBe('function');
      expect(typeof provedor.obterUltimaPosicao).toBe('function');
    }
  });

  it('o orquestrador recebe o registro, não as classes concretas', () => {
    const orquestrador = modulo.get(ConsultarPosicaoService) as unknown as {
      provedores: ProvedorDeRastreamento[];
    };

    expect(orquestrador.provedores).toBe(
      modulo.get(PROVEDORES_DE_RASTREAMENTO),
    );
  });

  it('a sessão da M7 usa o store compartilhado do módulo global', () => {
    const auth = modulo.get(M7AuthService, { strict: false }) as unknown as {
      store: VendorSessionStore;
    };

    expect(auth.store).toBe(modulo.get(VendorSessionStore));
  });
});
