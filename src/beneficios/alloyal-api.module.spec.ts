import { Global, Injectable, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AlloyalApiModule } from 'src/beneficios/alloyal-api.module';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { AlloyalCashbackService } from 'src/beneficios/services/alloyal-cashback.service';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { AlloyalCuponsService } from 'src/beneficios/services/alloyal-cupons.service';
import { AlloyalSessaoService } from 'src/beneficios/services/alloyal-sessao.service';
import { AlloyalUsuariosService } from 'src/beneficios/services/alloyal-usuarios.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';
import { AlloyalClient } from 'src/integrations/alloyal/alloyal.client';
import { AlloyalGateway } from 'src/integrations/alloyal/alloyal.gateway';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * Os globais de que o módulo depende em produção: `SharedModule`
 * (credenciais por base) e `CacheModule` + `RedisModule` (cache).
 */
@Global()
@Module({
  providers: [
    TenantCredentialsRegistry,
    CacheService,
    { provide: REDIS_CLIENTE, useValue: new RedisEmMemoria().comoRedis() },
  ],
  exports: [TenantCredentialsRegistry, CacheService],
})
class GlobaisDeTeste {}

/** Como o `DirectPartnersService`: outro módulo que lê as categorias. */
@Injectable()
class LeitorDeCategorias {
  constructor(readonly categorias: AlloyalCategoriesCacheService) {}
}

@Module({ imports: [AlloyalApiModule], providers: [LeitorDeCategorias] })
class ModuloConsumidor {}

describe('AlloyalApiModule (montagem)', () => {
  let modulo: TestingModule;

  beforeAll(async () => {
    modulo = await Test.createTestingModule({
      imports: [GlobaisDeTeste, AlloyalApiModule, ModuloConsumidor],
    }).compile();
  });

  afterAll(() => modulo.close());

  it('resolve o controller e todos os services só com os módulos globais', () => {
    for (const classe of [
      AlloyalApiController,
      AlloyalSessaoService,
      AlloyalCatalogoService,
      AlloyalCashbackService,
      AlloyalUsuariosService,
      AlloyalCuponsService,
      AlloyalCategoriesCacheService,
    ]) {
      // `get()` lança para provider ausente e para escopo REQUEST/TRANSIENT:
      // tudo aqui é singleton, sem estado da requisição.
      expect(modulo.get(classe, { strict: false })).toBeInstanceOf(classe);
    }
  });

  it('os services falam com a Alloyal pela porta, que é o AlloyalClient', () => {
    expect(modulo.get(AlloyalGateway, { strict: false })).toBeInstanceOf(
      AlloyalClient,
    );
  });

  it('exporta o AlloyalCategoriesCacheService: outro módulo recebe a MESMA instância', () => {
    const leitor = modulo.get(LeitorDeCategorias, { strict: false });

    expect(leitor.categorias).toBe(
      modulo.get(AlloyalCategoriesCacheService, { strict: false }),
    );
  });

  it.each([
    ['um service de caso de uso', AlloyalCatalogoService],
    ['a porta da Alloyal', AlloyalGateway],
  ])('não exporta %s: outro módulo não consegue injetar', async (_o, token) => {
    @Module({
      imports: [AlloyalApiModule],
      providers: [
        { provide: 'INTRUSO', useFactory: (d: unknown) => d, inject: [token] },
      ],
    })
    class ModuloIntruso {}

    await expect(
      Test.createTestingModule({
        imports: [GlobaisDeTeste, ModuloIntruso],
      }).compile(),
    ).rejects.toThrow(/can't resolve dependencies/i);
  });
});
