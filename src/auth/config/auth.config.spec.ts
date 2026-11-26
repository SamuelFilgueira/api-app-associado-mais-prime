import { jwtSecret } from 'src/auth/config/auth.config';

describe('jwtSecret', () => {
  it('usa o JWT_SECRET do ambiente', () => {
    expect(
      jwtSecret({ JWT_SECRET: 'segredo-real', NODE_ENV: 'production' }),
    ).toBe('segredo-real');
  });

  it('em produção, sem JWT_SECRET, falha em vez de usar o segredo do código', () => {
    expect(() => jwtSecret({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => jwtSecret({ NODE_ENV: 'production', JWT_SECRET: '' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('fora de produção mantém o valor de desenvolvimento', () => {
    expect(jwtSecret({})).toBe('minha_chave_secreta');
    expect(jwtSecret({ NODE_ENV: 'test' })).toBe('minha_chave_secreta');
  });
});
