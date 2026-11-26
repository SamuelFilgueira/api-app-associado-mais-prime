import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import { NotFoundException } from '@nestjs/common';
import { AxiosError } from 'axios';
import { FalhaAutenticacaoSga } from 'src/integrations/hinova/sga-auth.service';
import {
  DomainError,
  InfraError,
  IntegrationError,
} from 'src/shared/erros/erros';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import { resumirErros } from 'src/sga/helpers/resumo-de-erros.helper';
import {
  classificarErroDoBoleto,
  ehInstabilidadeComprovada,
  ehStatusInstavel,
  erroDaExcecaoSga,
  erroDaRespostaSga,
} from 'src/sga/helpers/sga-instabilidade.helper';

describe('sga-instabilidade.helper', () => {
  it.each([401, 403, 408, 429, 500, 502, 503, 504])(
    'HTTP %i é instabilidade',
    (status) => {
      expect(ehStatusInstavel(status)).toBe(true);
      expect(erroDaRespostaSga('x', status, {})).toBeInstanceOf(
        BoletoReativacaoInstabilidadeError,
      );
    },
  );

  it.each([400, 404, 406, 409, 422])('HTTP %i é definitivo', (status) => {
    expect(ehStatusInstavel(status)).toBe(false);
    expect(erroDaRespostaSga('x', status, {})).toBeInstanceOf(
      BoletoReativacaoDefinitivoError,
    );
  });

  it('exceção de rede/timeout vira instabilidade com a etapa no texto', () => {
    const erro = erroDaExcecaoSga('boleto/cadastrar', new Error('timeout'));
    expect(erro).toBeInstanceOf(BoletoReativacaoInstabilidadeError);
    expect(erro.message).toContain('boleto/cadastrar');
    expect(erro.message).toContain('timeout');
  });

  it('erro já tipado passa inalterado', () => {
    const original = new BoletoReativacaoDefinitivoError('x', 'etapa', 404);
    expect(erroDaExcecaoSga('y', original)).toBe(original);
  });

  it('resume o corpo da resposta no texto do erro', () => {
    const erro = erroDaRespostaSga('associado/buscar', 500, {
      mensagem: 'erro interno',
    });
    expect(erro.message).toContain('HTTP 500');
    expect(erro.message).toContain('erro interno');
  });

  describe('exceção durante a chamada ao SGA', () => {
    it('credencial ausente para a base e base não resolvida são definitivas', () => {
      expect(
        erroDaExcecaoSga(
          'associado/buscar',
          new IntegrationError({ vendor: 'hinova', tipo: 'nao_configurada' }),
        ),
      ).toBeInstanceOf(BoletoReativacaoDefinitivoError);
      expect(
        erroDaExcecaoSga('x', new BaseNaoResolvidaError('boleto')),
      ).toBeInstanceOf(BoletoReativacaoDefinitivoError);
    });

    it('disjuntor aberto e falha de login seguem como instabilidade', () => {
      expect(
        erroDaExcecaoSga(
          'x',
          new IntegrationError({ vendor: 'hinova', tipo: 'circuito_aberto' }),
        ),
      ).toBeInstanceOf(BoletoReativacaoInstabilidadeError);
      expect(
        erroDaExcecaoSga('x', new FalhaAutenticacaoSga('login', true)),
      ).toBeInstanceOf(BoletoReativacaoInstabilidadeError);
    });
  });

  describe('classificação de um erro qualquer da tentativa', () => {
    const comCodigo = (code: string) =>
      Object.assign(new Error(code), { code });

    it.each([
      ['timeout do axios', comCodigo('ECONNABORTED')],
      ['conexão recusada', comCodigo('ECONNREFUSED')],
      ['DNS', comCodigo('EAI_AGAIN')],
      ['axios sem resposta', new AxiosError('Network Error', 'ERR_NETWORK')],
      [
        'axios com 503',
        new AxiosError('x', 'ERR_BAD_RESPONSE', undefined, undefined, {
          status: 503,
        } as never),
      ],
      ['login recusado na Hinova', new FalhaAutenticacaoSga('login', false)],
      [
        'disjuntor aberto',
        new IntegrationError({ vendor: 'hinova', tipo: 'circuito_aberto' }),
      ],
      ['fila/Redis fora', new InfraError('fila')],
      ['banco fora', comCodigo('P1001')],
      ['pool do banco esgotado', comCodigo('P2024')],
    ])('%s é instabilidade (entra no retry)', (_caso, erro) => {
      expect(ehInstabilidadeComprovada(erro)).toBe(true);
      expect(classificarErroDoBoleto(erro)).toBeInstanceOf(
        BoletoReativacaoInstabilidadeError,
      );
    });

    it.each([
      ['exceção de programação', new TypeError('x is not a function')],
      ['erro genérico sem código', new Error('algo deu errado')],
      ['base não resolvida', new BaseNaoResolvidaError('boleto')],
      ['regra de negócio', new DomainError('X', 'regra')],
      ['registro inexistente (Nest)', new NotFoundException('sumiu')],
      ['violação de única no banco', comCodigo('P2002')],
      ['valor que não cabe na coluna', comCodigo('P2000')],
      [
        'axios com 422',
        new AxiosError('x', 'ERR_BAD_REQUEST', undefined, undefined, {
          status: 422,
        } as never),
      ],
      [
        'vendor recusou',
        new IntegrationError({ vendor: 'hinova', tipo: 'recusado' }),
      ],
      ['valor que não é erro', 'texto'],
    ])('%s é definitivo (vai para FALHA)', (_caso, erro) => {
      expect(ehInstabilidadeComprovada(erro)).toBe(false);
      expect(classificarErroDoBoleto(erro)).toBeInstanceOf(
        BoletoReativacaoDefinitivoError,
      );
    });

    it('a mensagem do erro definitivo guarda o motivo (vai para boletoUltimoErro)', () => {
      expect(
        classificarErroDoBoleto(
          new BaseNaoResolvidaError('boleto de reativação'),
        ).message,
      ).toBe(
        'erro não recuperável: base do associado não resolvida (boleto de reativação)',
      );
      expect(
        classificarErroDoBoleto(new TypeError('x is undefined')).message,
      ).toBe('erro não recuperável: x is undefined');
    });

    it('erro já tipado passa inalterado', () => {
      const tipado = new BoletoReativacaoInstabilidadeError('x', 'etapa', 503);
      expect(classificarErroDoBoleto(tipado)).toBe(tipado);
    });
  });
});

describe('resumirErros', () => {
  it('lista até cinco erros por extenso e conta o restante', () => {
    expect(resumirErros(['a', 'b'])).toBe('a; b');
    expect(resumirErros(['1', '2', '3', '4', '5', '6', '7'])).toBe(
      '1; 2; 3; 4; 5; e mais 2',
    );
  });
});
