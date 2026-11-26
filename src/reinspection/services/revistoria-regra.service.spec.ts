import { resetTenantConfigCache } from 'src/config/tenant.config';
import { RevistoriaRegraService } from 'src/reinspection/services/revistoria-regra.service';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

describe('RevistoriaRegraService', () => {
  const envOriginal = { ...process.env };
  let service: RevistoriaRegraService;

  beforeEach(() => {
    process.env.TENANT_BASES = 'MAIS_PRIME:,HERTZ:_HERTZ';
    resetTenantConfigCache();
    service = new RevistoriaRegraService();
  });

  afterEach(() => {
    process.env = { ...envOriginal };
    resetTenantConfigCache();
  });

  describe('getRegra (GET /reinspection/regra — app)', () => {
    it('devolve a regra da base do associado', () => {
      expect(service.getRegra('HERTZ')).toMatchObject({
        baseOrigin: 'HERTZ',
        perfil: 'HERTZ',
        situacoesRevistoria: ['INADIMPLENTE'],
      });
      expect(service.getRegra('MAIS_PRIME')).toMatchObject({
        baseOrigin: 'MAIS_PRIME',
        perfil: 'PADRAO',
      });
    });

    it.each([undefined, null, '', 'BASE_DE_OUTRO_DEPLOY'])(
      'base %p → BaseNaoResolvidaError (não cai na regra da base padrão)',
      (base) => {
        expect(() => service.getRegra(base)).toThrow(BaseNaoResolvidaError);
      },
    );

    it('o erro é 422 BASE_NAO_RESOLVIDA', () => {
      // MAIS_PRIME é a base padrão deste deploy: era a regra dela que um
      // associado HERTZ sem base no token recebia, em silêncio.
      const erro = (() => {
        try {
          return service.getRegra(undefined);
        } catch (e) {
          return e as unknown;
        }
      })();

      expect(erro).toBeInstanceOf(BaseNaoResolvidaError);
      expect(erro).toMatchObject({ code: 'BASE_NAO_RESOLVIDA', status: 422 });
    });
  });

  describe('getRegras (GET /reinspection/regras — painel)', () => {
    it('lista a regra de cada base configurada, sem depender de base no token', () => {
      expect(service.getRegras().map((r) => [r.baseOrigin, r.perfil])).toEqual([
        ['MAIS_PRIME', 'PADRAO'],
        ['HERTZ', 'HERTZ'],
      ]);
    });
  });

  it('o log de boot percorre as bases configuradas sem lançar', () => {
    expect(() => service.onModuleInit()).not.toThrow();
  });
});
