import { resetTenantConfigCache } from 'src/config/tenant.config';
import {
  descreverRegraRevistoria,
  getRegraRevistoria,
  REGRA_HERTZ,
  REGRA_PADRAO,
  resolverTemplateRevistoria,
  situacaoExigeRevistoria,
} from 'src/config/revistoria-regra.config';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

/**
 * Cópia literal de `mapTipoToVehicleType` do app (services/revistoriaService.ts),
 * usada como oráculo: a regra padrão do backend não pode divergir dela.
 */
function mapTipoLegadoDoApp(tipo: string) {
  const upper = tipo.toUpperCase();
  if (
    upper.includes('VEICULOS - LEVES') ||
    upper.includes('VEICULOS LEVES') ||
    upper.includes('GRUPO 1') ||
    upper.includes('GRUPO 2') ||
    upper.includes('VEICULOS CAMIONETA')
  ) {
    return 'VEICULOS_LEVES';
  }
  if (
    upper.includes('VEICULOS MOTOCICLETA') ||
    upper.includes('MOTOCICLETA') ||
    upper.includes('GRUPO 3') ||
    upper.includes('MOTOS') ||
    upper.includes('MOTO')
  ) {
    return 'MOTOS';
  }
  if (
    upper.includes('VEICULOS CAMINHOES') ||
    upper.includes('CAMINHOES') ||
    upper.includes('CAMINHÃO') ||
    upper.includes('GRUPO 4')
  ) {
    return 'CAMINHOES';
  }
  return 'VEICULOS_LEVES';
}

describe('revistoria-regra.config', () => {
  const envOriginal = { ...process.env };

  afterEach(() => {
    process.env = { ...envOriginal };
    resetTenantConfigCache();
  });

  describe('regra padrão (Mais Prime / Mais Prime RS) — inalterada', () => {
    beforeEach(() => {
      process.env.TENANT_BASES = 'MAIS_PRIME:,MAIS_PRIME_RS:_RS';
      resetTenantConfigCache();
    });

    it('MAIS_PRIME e MAIS_PRIME_RS usam a regra padrão', () => {
      expect(getRegraRevistoria('MAIS_PRIME')).toBe(REGRA_PADRAO);
      expect(getRegraRevistoria('MAIS_PRIME_RS')).toBe(REGRA_PADRAO);
    });

    it('boleto vigente: conta 27, tipo 2, veículo → 20 após o boleto, reativa com 1', () => {
      for (const base of ['MAIS_PRIME', 'MAIS_PRIME_RS']) {
        expect(getRegraRevistoria(base).boleto).toEqual({
          codigoConta: 27,
          codigoTipoBoleto: 2,
          situacaoVeiculoAposBoleto: 20,
          situacaoVeiculoAposPagamento: 1,
          situacaoAssociadoAposPagamento: 1,
          // Mais Prime: boleto pelo valor base, sem multa nem mora.
          encargosPorAtraso: null,
        });
      }
    });

    it('só INADIMPLENTE 20 DIAS exige revistoria', () => {
      for (const base of ['MAIS_PRIME', 'MAIS_PRIME_RS']) {
        expect(situacaoExigeRevistoria('INADIMPLENTE 20 DIAS', base)).toBe(
          true,
        );
        expect(situacaoExigeRevistoria('INADIMPLENTE', base)).toBe(false);
        expect(situacaoExigeRevistoria('ATIVO', base)).toBe(false);
        expect(situacaoExigeRevistoria(null, base)).toBe(false);
      }
    });

    it('template idêntico ao mapTipoToVehicleType do app', () => {
      const tipos = [
        'VEICULOS - LEVES',
        'VEICULOS LEVES',
        'GRUPO 1 - PASSEIO',
        'GRUPO 2',
        'VEICULOS CAMIONETA',
        'VEICULOS MOTOCICLETA',
        'MOTOCICLETA',
        'GRUPO 3',
        'MOTOS',
        'VEICULOS CAMINHOES',
        'CAMINHOES',
        'CAMINHÃO',
        'CAMINHÕES',
        'GRUPO 4',
        'veiculos leves',
        'AUTOMOVEL LEVE',
        'CAMIONETAS, UTILITARIOS, HIBRIDOS E TROLLER',
        'MICRO-ONIBUS, MINIBUS E CAMINHOES',
        'TIPO DESCONHECIDO',
      ];
      for (const tipo of tipos) {
        expect(resolverTemplateRevistoria(tipo, 'MAIS_PRIME')).toBe(
          mapTipoLegadoDoApp(tipo),
        );
        expect(resolverTemplateRevistoria(tipo, 'MAIS_PRIME_RS')).toBe(
          mapTipoLegadoDoApp(tipo),
        );
      }
    });
  });

  describe('regra da Hertz', () => {
    beforeEach(() => {
      process.env.TENANT_BASES = 'HERTZ';
      resetTenantConfigCache();
    });

    it('HERTZ usa a regra própria', () => {
      expect(getRegraRevistoria('HERTZ')).toBe(REGRA_HERTZ);
    });

    it('INADIMPLENTE exige revistoria; demais situações não', () => {
      expect(situacaoExigeRevistoria('INADIMPLENTE', 'HERTZ')).toBe(true);
      expect(situacaoExigeRevistoria(' inadimplente ', 'HERTZ')).toBe(true);
      expect(situacaoExigeRevistoria('INADIMPLENTE 20 DIAS', 'HERTZ')).toBe(
        false,
      );
      expect(situacaoExigeRevistoria('ATIVO', 'HERTZ')).toBe(false);
    });

    it.each([
      ['AUTOMOVEL LEVE', 'VEICULOS_LEVES'],
      ['AUTOMOVEL LEVES', 'VEICULOS_LEVES'],
      ['AUTOMÓVEL LEVE', 'VEICULOS_LEVES'],
      ['CAMIONETAS, UTILITARIOS, HIBRIDOS E TROLLER', 'VEICULOS_LEVES'],
      ['CAMIONETAS, UTILITÁRIOS, HÍBRIDOS E TROLLER', 'VEICULOS_LEVES'],
      ['MICRO-ONIBUS, MINIBUS E CAMINHOES', 'CAMINHOES'],
      ['MICRO-ÔNIBUS, MINIBUS E CAMINHÕES', 'CAMINHOES'],
      [' micro-onibus,  minibus e caminhoes ', 'CAMINHOES'],
      ['MOTOCICLETA', 'MOTOS'],
    ])('tipo "%s" → %s', (tipo, template) => {
      expect(resolverTemplateRevistoria(tipo, 'HERTZ')).toBe(template);
    });

    it('tipo vazio ou desconhecido cai em VEICULOS_LEVES', () => {
      expect(resolverTemplateRevistoria(null, 'HERTZ')).toBe('VEICULOS_LEVES');
      expect(resolverTemplateRevistoria('OUTRO', 'HERTZ')).toBe(
        'VEICULOS_LEVES',
      );
    });

    it('boleto: conta 2, tipo 2, não altera o veículo após o boleto, reativa com 1', () => {
      expect(getRegraRevistoria('HERTZ').boleto).toEqual({
        codigoConta: 2,
        codigoTipoBoleto: 2,
        situacaoVeiculoAposBoleto: null,
        situacaoVeiculoAposPagamento: 1,
        situacaoAssociadoAposPagamento: 1,
        encargosPorAtraso: {
          multaPercentual: 2,
          moraDiariaPercentual: 0.5,
          cancelarBoletoEmAberto: true,
        },
      });
    });

    it('encargos por atraso são SÓ da Hertz: nenhuma outra base os cobra', () => {
      process.env.TENANT_BASES = 'MAIS_PRIME:,MAIS_PRIME_RS:_RS,HERTZ:_HERTZ';
      resetTenantConfigCache();

      expect(
        getRegraRevistoria('HERTZ').boleto.encargosPorAtraso,
      ).not.toBeNull();
      expect(
        getRegraRevistoria('MAIS_PRIME').boleto.encargosPorAtraso,
      ).toBeNull();
      expect(
        getRegraRevistoria('MAIS_PRIME_RS').boleto.encargosPorAtraso,
      ).toBeNull();
      expect(REGRA_PADRAO.boleto.encargosPorAtraso).toBeNull();
    });

    it('descreve a regra para app e painel', () => {
      expect(descreverRegraRevistoria('HERTZ')).toEqual({
        baseOrigin: 'HERTZ',
        perfil: 'HERTZ',
        situacoesRevistoria: ['INADIMPLENTE'],
        modoComparacaoTipo: 'exato',
        tiposPorTemplate: {
          VEICULOS_LEVES: [
            'AUTOMOVEL LEVE',
            'AUTOMOVEL LEVES',
            'CAMIONETAS, UTILITARIOS, HIBRIDOS E TROLLER',
          ],
          MOTOS: ['MOTOCICLETA'],
          CAMINHOES: ['MICRO-ONIBUS, MINIBUS E CAMINHOES'],
        },
        templatePadrao: 'VEICULOS_LEVES',
      });
    });
  });
  describe('base ausente ou de outro deploy — falha em vez de usar a base padrão', () => {
    beforeEach(() => {
      // Deploy com duas regras diferentes: MAIS_PRIME (padrão) e HERTZ.
      process.env.TENANT_BASES = 'MAIS_PRIME:,HERTZ:_HERTZ';
      resetTenantConfigCache();
    });

    it.each([undefined, null, ''])(
      'getRegraRevistoria(%p) lança BaseNaoResolvidaError',
      (base) => {
        expect(() => getRegraRevistoria(base)).toThrow(BaseNaoResolvidaError);
      },
    );

    it('base que não pertence a este deploy também lança', () => {
      expect(() => getRegraRevistoria('MAIS_PRIME_RS')).toThrow(
        BaseNaoResolvidaError,
      );
      expect(() => getRegraRevistoria('hertz')).toThrow(BaseNaoResolvidaError);
    });

    it('sem base, a situação do veículo NÃO é avaliada pela regra da base padrão', () => {
      // Na regra padrão (Mais Prime) INADIMPLENTE não exige revistoria; na
      // da Hertz exige. Antes, um associado HERTZ sem base recebia `false`.
      expect(situacaoExigeRevistoria('INADIMPLENTE', 'HERTZ')).toBe(true);
      expect(situacaoExigeRevistoria('INADIMPLENTE', 'MAIS_PRIME')).toBe(false);
      expect(() => situacaoExigeRevistoria('INADIMPLENTE', undefined)).toThrow(
        BaseNaoResolvidaError,
      );
    });

    it('sem base, o template não é resolvido pela regra da base padrão', () => {
      expect(() =>
        resolverTemplateRevistoria('MOTOCICLETA', undefined),
      ).toThrow(BaseNaoResolvidaError);
    });

    it('base configurada sem regra própria segue na regra padrão', () => {
      process.env.TENANT_BASES = 'MAIS_PRIME:,OUTRA_EMPRESA:_OUTRA';
      resetTenantConfigCache();
      expect(getRegraRevistoria('OUTRA_EMPRESA')).toBe(REGRA_PADRAO);
    });

    it('as bases configuradas continuam sendo descritas (painel e log de boot)', () => {
      expect(descreverRegraRevistoria('MAIS_PRIME').perfil).toBe('PADRAO');
      expect(descreverRegraRevistoria('HERTZ').perfil).toBe('HERTZ');
    });
  });
});
