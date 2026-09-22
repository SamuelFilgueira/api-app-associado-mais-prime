import { TokenResolverService } from './token-resolver.service';

describe('TokenResolverService.resolveSgaBaseTokens', () => {
  const envOriginal = { ...process.env };
  const limpar = () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TOKEN_BASE_SGA_MAIS_PRIME')) delete process.env[k];
    }
  };

  beforeEach(limpar);
  afterAll(() => {
    process.env = envOriginal;
  });

  it('só o nome puro → lista com um token (comportamento original)', () => {
    process.env.TOKEN_BASE_SGA_MAIS_PRIME = 'tok';
    const r = new TokenResolverService();
    expect(r.resolveSgaBaseTokens('MAIS_PRIME')).toEqual(['tok']);
    expect(r.resolveSgaBaseToken('MAIS_PRIME')).toBe('tok');
  });

  it('só numerados (…1, …2) → lista na ordem, sem exigir o nome puro', () => {
    process.env.TOKEN_BASE_SGA_MAIS_PRIME1 = 'tok-1';
    process.env.TOKEN_BASE_SGA_MAIS_PRIME2 = 'tok-2';
    const r = new TokenResolverService();
    expect(r.resolveSgaBaseTokens('MAIS_PRIME')).toEqual(['tok-1', 'tok-2']);
    expect(r.resolveSgaBaseToken('MAIS_PRIME')).toBe('tok-1');
  });

  it('nome puro + numerados, com duplicado e vazio → dedupe e ignora vazios', () => {
    process.env.TOKEN_BASE_SGA_MAIS_PRIME = 'tok-1';
    process.env.TOKEN_BASE_SGA_MAIS_PRIME1 = 'tok-1';
    process.env.TOKEN_BASE_SGA_MAIS_PRIME2 = '  ';
    process.env.TOKEN_BASE_SGA_MAIS_PRIME3 = 'tok-3';
    const r = new TokenResolverService();
    expect(r.resolveSgaBaseTokens('MAIS_PRIME')).toEqual(['tok-1', 'tok-3']);
  });

  it('nenhum configurado → erro citando a variável', () => {
    const r = new TokenResolverService();
    expect(() => r.resolveSgaBaseTokens('MAIS_PRIME')).toThrow(
      'TOKEN_BASE_SGA_MAIS_PRIME',
    );
  });
});
