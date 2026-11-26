import { ForbiddenException } from '@nestjs/common';
import { segredosIguais } from 'src/infra/auth/comparacao-segura';
import {
  ehAdmin,
  ehDonoDaConta,
  exigirDocumentoProprioOuAdmin,
  exigirDonoOuAdmin,
  somenteDigitos,
} from 'src/infra/auth/usuario-autenticado';

describe('usuario-autenticado', () => {
  const associado = { userId: 7, role: 'USER', cpf: '11122233344' };
  const painel = { userId: 7, role: 'ADMIN', adminRole: 'COBRANCA' };
  const adminLegado = { userId: 2, role: 'ADMIN' };

  it('dono da conta é o associado com o mesmo id', () => {
    expect(ehDonoDaConta(associado, 7)).toBe(true);
    expect(ehDonoDaConta(associado, 8)).toBe(false);
    expect(ehDonoDaConta(undefined, 7)).toBe(false);
  });

  it('id de usuário do painel nunca identifica um associado', () => {
    expect(ehDonoDaConta(painel, 7)).toBe(false);
  });

  it('aceita `userId` como string numérica (claim serializada)', () => {
    expect(ehDonoDaConta({ userId: '7' as unknown as number }, 7)).toBe(true);
  });

  it('exigirDonoOuAdmin: dono e ADMIN passam; terceiros levam 403', () => {
    expect(() => exigirDonoOuAdmin(associado, 7)).not.toThrow();
    expect(() => exigirDonoOuAdmin(painel, 123)).not.toThrow();
    expect(() => exigirDonoOuAdmin(adminLegado, 123)).not.toThrow();
    expect(() => exigirDonoOuAdmin(associado, 8)).toThrow(ForbiddenException);
    expect(() => exigirDonoOuAdmin(undefined, 8)).toThrow(ForbiddenException);
  });

  it('exigirDocumentoProprioOuAdmin compara só os dígitos', () => {
    expect(() =>
      exigirDocumentoProprioOuAdmin(associado, associado.cpf, '111.222.333-44'),
    ).not.toThrow();
    expect(() =>
      exigirDocumentoProprioOuAdmin(associado, associado.cpf, '55566677788'),
    ).toThrow(ForbiddenException);
  });

  it('documento ausente nunca casa com documento ausente', () => {
    expect(() => exigirDocumentoProprioOuAdmin(associado, '', '')).toThrow(
      ForbiddenException,
    );
    expect(() =>
      exigirDocumentoProprioOuAdmin(associado, undefined, undefined),
    ).toThrow(ForbiddenException);
  });

  it('helpers básicos', () => {
    expect(somenteDigitos('111.222.333-44')).toBe('11122233344');
    expect(somenteDigitos(null)).toBe('');
    expect(ehAdmin(painel)).toBe(true);
    expect(ehAdmin(associado)).toBe(false);
  });
});

describe('segredosIguais', () => {
  it('iguais → true; diferentes, vazios ou não-string → false', () => {
    expect(segredosIguais('abc123', 'abc123')).toBe(true);
    expect(segredosIguais('abc123', 'abc124')).toBe(false);
    expect(segredosIguais('abc', 'abc123')).toBe(false);
    expect(segredosIguais('', '')).toBe(false);
    expect(segredosIguais(undefined, undefined)).toBe(false);
    expect(segredosIguais(['abc123'], 'abc123')).toBe(false);
  });
});
