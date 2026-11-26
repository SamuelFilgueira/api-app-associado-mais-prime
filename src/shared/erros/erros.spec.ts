import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DomainError,
  InfraError,
  IntegrationError,
  ehErroTransitorio,
  integracaoNaoConfigurada,
} from 'src/shared/erros/erros';

const comCodigo = (code: string, extra: object = {}) =>
  Object.assign(new Error(code), { code, ...extra });

describe('ehErroTransitorio — o que vale repetir num job', () => {
  it('regra de negócio e recusa do vendor: definitivo', () => {
    expect(ehErroTransitorio(new DomainError('X', 'x'))).toBe(false);
    expect(
      ehErroTransitorio(
        new IntegrationError({ vendor: 'hinova', tipo: 'recusado' }),
      ),
    ).toBe(false);
    expect(
      ehErroTransitorio(integracaoNaoConfigurada('m7', 'B', 'MO7_TOKEN')),
    ).toBe(false);
    expect(ehErroTransitorio(new BadRequestException())).toBe(false);
  });

  it('vendor fora, circuito aberto, infraestrutura e 5xx: transitório', () => {
    for (const tipo of [
      'timeout',
      'indisponivel',
      'circuito_aberto',
    ] as const) {
      expect(
        ehErroTransitorio(new IntegrationError({ vendor: 'hinova', tipo })),
      ).toBe(true);
    }
    expect(ehErroTransitorio(new InfraError('banco'))).toBe(true);
    expect(ehErroTransitorio(new ServiceUnavailableException())).toBe(true);
  });

  it.each(['P2034', 'P2024', 'P1001', 'P1008', 'P2028'])(
    'Prisma %s (deadlock, pool, conexão): transitório',
    (code) => expect(ehErroTransitorio(comCodigo(code))).toBe(true),
  );

  it.each(['P2002', 'P2003', 'P2025'])(
    'Prisma %s (violação dos dados): definitivo',
    (code) => expect(ehErroTransitorio(comCodigo(code))).toBe(false),
  );

  it('axios: 5xx e rede repetem; 4xx não; 429 repete', () => {
    expect(ehErroTransitorio(comCodigo('ERR_BAD_RESPONSE'))).toBe(true);
    expect(ehErroTransitorio(comCodigo('ECONNRESET'))).toBe(true);
    expect(ehErroTransitorio(comCodigo('ECONNABORTED'))).toBe(true);
    expect(
      ehErroTransitorio(
        comCodigo('ERR_BAD_REQUEST', { response: { status: 404 } }),
      ),
    ).toBe(false);
    expect(
      ehErroTransitorio(
        comCodigo('ERR_BAD_REQUEST', { response: { status: 429 } }),
      ),
    ).toBe(true);
  });

  it('erro desconhecido, com ou sem código: transitório (não perde o job)', () => {
    expect(ehErroTransitorio(new Error('algo inesperado'))).toBe(true);
    expect(ehErroTransitorio(comCodigo('CODIGO_QUE_NINGUEM_CONHECE'))).toBe(
      true,
    );
    expect(ehErroTransitorio('texto solto')).toBe(true);
  });
});
