import { carregarAppConfig } from 'src/config/app.config';
import {
  contextoExecucao,
  normalizarRequestId,
} from 'src/infra/observability/contexto-execucao';
import { LoggerEstruturado } from 'src/infra/observability/logger-estruturado';
import { ehEnderecoInterno } from 'src/infra/observability/metrics.controller';
import { redigirTexto, redigirValor } from 'src/infra/observability/redacao';

describe('redação de log', () => {
  it('mascara CPF formatado e CPF em contexto de documento', () => {
    expect(redigirTexto('CPF 529.982.247-25 sem acesso')).toBe(
      'CPF ***.***.247-25 sem acesso',
    );
    expect(redigirTexto('detectBaseOrigin CPF=52998224725 base=X')).toBe(
      'detectBaseOrigin CPF=***.***.247-25 base=X',
    );
    expect(
      redigirTexto('GET https://api/sga/v2/associado/buscar/52998224725'),
    ).toBe('GET https://api/sga/v2/associado/buscar/***.***.247-25');
  });

  it('não confunde outros números de 11 dígitos com CPF', () => {
    expect(redigirTexto('nosso_numero=12345678901 pago')).toBe(
      'nosso_numero=12345678901 pago',
    );
  });

  it('mascara Bearer, JWT, senha e token em JSON', () => {
    expect(redigirTexto('Authorization: Bearer abcdef1234567890')).toBe(
      'Authorization: Bearer [redigido]',
    );
    expect(
      redigirTexto(
        'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEyMzQ1Njc4OTB9.c2lnbmF0dXJhZmFsc2E recebido',
      ),
    ).toBe('token [jwt] recebido');
    expect(redigirTexto('{"usuario":"x","senha":"s3gr3d0"}')).toBe(
      '{"usuario":"x","senha":"[redigido]"}',
    );
    expect(redigirTexto('{"token_usuario":"abc","ok":true}')).toBe(
      '{"token_usuario":"[redigido]","ok":true}',
    );
  });

  it('encurta o Expo push token', () => {
    expect(redigirTexto('ExponentPushToken[abcdEFGH1234567890xyz]')).toBe(
      'ExponentPushToken[abcd…]',
    );
  });

  it('em objeto: chaves sensíveis somem em qualquer profundidade', () => {
    expect(
      redigirValor({
        headers: { authorization: 'Bearer x', 'user-agent': 'app' },
        user: { passwordHash: '$2b$10$abc', nome: 'Fulano' },
        lista: [{ token: 't' }],
      }),
    ).toEqual({
      headers: { authorization: '[redigido]', 'user-agent': 'app' },
      user: { passwordHash: '[redigido]', nome: 'Fulano' },
      lista: [{ token: '[redigido]' }],
    });
  });
});

describe('LoggerEstruturado (JSON)', () => {
  const montar = (env: NodeJS.ProcessEnv = {}) => {
    const linhas: Array<Record<string, unknown>> = [];
    const logger = new LoggerEstruturado(
      carregarAppConfig({ LOG_FORMAT: 'json', APP_ROLE: 'worker', ...env }),
      (linha) => linhas.push(JSON.parse(linha) as Record<string, unknown>),
    );
    return { logger, linhas };
  };

  it('linha com campos fixos e o contexto da requisição', () => {
    const { logger, linhas } = montar();

    contextoExecucao.executar(
      { requestId: 'req-12345678', base: 'MAIS_PRIME', userId: 7 },
      () => logger.log('Boleto gerado', 'BoletoService'),
    );

    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      level: 'log',
      context: 'BoletoService',
      msg: 'Boleto gerado',
      role: 'worker',
      requestId: 'req-12345678',
      base: 'MAIS_PRIME',
      userId: 7,
    });
    expect(typeof linhas[0].ts).toBe('string');
  });

  it('error(msg, stack, contexto) separa a stack e redige a mensagem', () => {
    const { logger, linhas } = montar();

    logger.error(
      'Falha para CPF 529.982.247-25',
      'Error: x\n    at f (a.ts:1:1)',
      'SgaService',
    );

    expect(linhas[0]).toMatchObject({
      level: 'error',
      context: 'SgaService',
      msg: 'Falha para CPF ***.***.247-25',
      stack: 'Error: x\n    at f (a.ts:1:1)',
    });
  });

  it('objeto como mensagem vai em `data`, já redigido', () => {
    const { logger, linhas } = montar();

    logger.log({ evento: 'http_request', status: 200, senha: 'x' }, 'HTTP');

    expect(linhas[0].data).toEqual({
      evento: 'http_request',
      status: 200,
      senha: '[redigido]',
    });
  });

  it('respeita o nível mínimo', () => {
    const { logger, linhas } = montar({ LOG_LEVEL: 'warn' });

    logger.log('ignorada', 'X');
    logger.debug('ignorada', 'X');
    logger.warn('passa', 'X');

    expect(linhas.map((l) => l.msg)).toEqual(['passa']);
  });

  it('LOG_REDIGIR_PII=false mantém o texto original', () => {
    const { logger, linhas } = montar({ LOG_REDIGIR_PII: 'false' });

    logger.log('CPF 529.982.247-25', 'X');

    expect(linhas[0].msg).toBe('CPF 529.982.247-25');
  });
});

describe('contexto de execução', () => {
  it('definir() enriquece o contexto em curso e não vaza para fora', async () => {
    await contextoExecucao.executar({ requestId: 'abc-12345' }, async () => {
      contextoExecucao.definir({ userId: 9, base: 'HERTZ' });
      await Promise.resolve();
      expect(contextoExecucao.atual()).toMatchObject({
        requestId: 'abc-12345',
        userId: 9,
        base: 'HERTZ',
      });
    });
    expect(contextoExecucao.atual()).toBeUndefined();
  });

  it('requestId do proxy só é aceito em formato seguro', () => {
    expect(normalizarRequestId('3f2c1a9e-aaaa-bbbb')).toBe(
      '3f2c1a9e-aaaa-bbbb',
    );
    expect(normalizarRequestId('curto')).not.toBe('curto');
    expect(normalizarRequestId('id com espaço e\nquebra')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(normalizarRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ehEnderecoInterno', () => {
  it.each(['127.0.0.1', '::1', '::ffff:10.1.2.3', '172.18.0.4', '192.168.1.5'])(
    '%s é interno',
    (ip) => expect(ehEnderecoInterno(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '172.32.0.1', '200.150.10.1', '', undefined])(
    '%s não é interno',
    (ip) => expect(ehEnderecoInterno(ip)).toBe(false),
  );
});
