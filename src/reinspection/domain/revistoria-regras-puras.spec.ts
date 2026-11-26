import {
  FotoParaEnvio,
  aplicarRetorno,
  descreverFalhaDaChamada,
  descreverRespostaInvalida,
  falhaComResultadoIncerto,
  resultadosIniciais,
  resumirResposta,
  selecionarFotos,
  statusDoEnvio,
  truncar,
} from 'src/reinspection/domain/hinova-envio';
import {
  JANELA_DE_REPETICAO_MS,
  UltimaRevistoriaDoVeiculo,
  ehRepeticaoDaAbertura,
} from 'src/reinspection/domain/revistoria-abertura';
import {
  extrairOrdemDoNomeArquivo,
  fotoIncompleta,
  limiteDaListagem,
  termosDeBusca,
} from 'src/reinspection/domain/revistoria-foto';

describe('abertura da revistoria', () => {
  const agora = new Date('2026-11-25T12:00:00.000Z');
  const ultima = (
    extra: Partial<UltimaRevistoriaDoVeiculo> = {},
  ): UltimaRevistoriaDoVeiculo => ({
    status: 'PENDENTE',
    vehicleType: 'MOTOS',
    codigoVeiculo: 10,
    createdAt: new Date(agora.getTime() - 1_000),
    totalFotos: 0,
    ...extra,
  });
  const pedido = { vehicleType: 'MOTOS', codigoVeiculo: 10 };

  it('pedido idêntico, logo em seguida, sobre revistoria vazia → repetição', () => {
    expect(ehRepeticaoDaAbertura(ultima(), pedido, agora)).toBe(true);
  });

  it('sem revistoria anterior → não é repetição', () => {
    expect(ehRepeticaoDaAbertura(null, pedido, agora)).toBe(false);
  });

  it('PENDENTE que já tem foto (envio que parou no meio) → cria outra', () => {
    expect(
      ehRepeticaoDaAbertura(ultima({ totalFotos: 1 }), pedido, agora),
    ).toBe(false);
  });

  it.each(['EM_ANALISE', 'APROVADA', 'REPROVADA', 'FINALIZADA'] as const)(
    'última %s → cria outra',
    (status) => {
      expect(ehRepeticaoDaAbertura(ultima({ status }), pedido, agora)).toBe(
        false,
      );
    },
  );

  it('dados diferentes do primeiro pedido → cria outra', () => {
    expect(
      ehRepeticaoDaAbertura(
        ultima(),
        { vehicleType: 'CAMINHOES', codigoVeiculo: 10 },
        agora,
      ),
    ).toBe(false);
    expect(
      ehRepeticaoDaAbertura(ultima(), { vehicleType: 'MOTOS' }, agora),
    ).toBe(false);
  });

  it('codigoVeiculo ausente dos dois lados conta como igual', () => {
    expect(
      ehRepeticaoDaAbertura(
        ultima({ codigoVeiculo: null }),
        { vehicleType: 'MOTOS' },
        agora,
      ),
    ).toBe(true);
  });

  it('fora da janela de repetição → cria outra (fluxo de sempre)', () => {
    const limite = new Date(agora.getTime() - JANELA_DE_REPETICAO_MS);
    expect(
      ehRepeticaoDaAbertura(ultima({ createdAt: limite }), pedido, agora),
    ).toBe(true);
    expect(
      ehRepeticaoDaAbertura(
        ultima({ createdAt: new Date(limite.getTime() - 1) }),
        pedido,
        agora,
      ),
    ).toBe(false);
  });
});

describe('regras de foto e listagem', () => {
  it.each([
    ['revistoria_ordem_3_1.jpg', 3],
    ['ordem-12.jpg', 12],
    ['ORDEM7.png', 7],
    ['foto.jpg', null],
    ['ordem_x.jpg', null],
  ])('ordem em "%s" → %s', (nome, ordem) => {
    expect(extrairOrdemDoNomeArquivo(nome)).toBe(ordem);
  });

  it('foto sem nome ou sem binário é incompleta', () => {
    expect(fotoIncompleta({ nomeArquivo: 'a.jpg', binario: 'x' })).toBe(false);
    expect(fotoIncompleta({ nomeArquivo: '', binario: 'x' })).toBe(true);
    expect(fotoIncompleta({ nomeArquivo: 'a.jpg', binario: '' })).toBe(true);
  });

  it('limite da listagem: 20 por padrão, teto de 100', () => {
    expect(limiteDaListagem()).toBe(20);
    expect(limiteDaListagem(7)).toBe(7);
    expect(limiteDaListagem(1000)).toBe(100);
  });

  it('termos de busca: apara espaços e exige ao menos um', () => {
    expect(termosDeBusca('  ', undefined)).toBeNull();
    expect(termosDeBusca(' 9BW ', '')).toEqual({ chassi: '9BW' });
    expect(termosDeBusca(undefined, ' ABC ')).toEqual({ plate: 'ABC' });
    expect(termosDeBusca('X', 'Y')).toEqual({ chassi: 'X', plate: 'Y' });
  });
});

describe('envio de fotos à Hinova (regra pura)', () => {
  const foto = (id: number, extra: Partial<FotoParaEnvio> = {}) => ({
    id,
    nomeArquivo: `f${id}.jpg`,
    codigoTipo: null,
    url: `uploads/${id}.jpg`,
    sentToHinova: false,
    ...extra,
  });

  describe('selecionarFotos', () => {
    const fotos = [foto(1, { sentToHinova: true }), foto(2), foto(3)];

    it('sem opções: só as ainda não inseridas', () => {
      expect(selecionarFotos(fotos, {})).toEqual({
        ok: true,
        fotos: [fotos[1], fotos[2]],
      });
    });

    it('forcar inclui as já inseridas', () => {
      expect(selecionarFotos(fotos, { forcar: true })).toEqual({
        ok: true,
        fotos,
      });
    });

    it('photoIds restringe; já inserida só entra com forcar', () => {
      expect(selecionarFotos(fotos, { photoIds: [1, 2] })).toEqual({
        ok: true,
        fotos: [fotos[1]],
      });
      expect(
        selecionarFotos(fotos, { photoIds: [1, 2], forcar: true }),
      ).toEqual({ ok: true, fotos: [fotos[0], fotos[1]] });
    });

    it('photoId de outra revistoria invalida a seleção', () => {
      expect(selecionarFotos(fotos, { photoIds: [2, 99] })).toEqual({
        ok: false,
      });
    });
  });

  describe('aplicarRetorno', () => {
    it('só "Inserido" marca a foto; nomes repetidos seguem a ordem de envio', () => {
      const enviadas = [
        foto(1, { nomeArquivo: 'x.jpg' }),
        foto(2, { nomeArquivo: 'x.jpg' }),
        foto(3, { nomeArquivo: 'y.jpg' }),
      ];
      const resultados = resultadosIniciais(enviadas);

      aplicarRetorno(
        enviadas,
        [
          { nome_arquivo: 'x.jpg', situacao: 'Inserido' },
          { nome_arquivo: 'x.jpg', situacao: 'Erro: duplicada' },
          { nome_arquivo: 'desconhecida.jpg', situacao: 'Inserido' },
        ],
        resultados,
      );

      expect(resultados.get(1)).toMatchObject({ inserida: true, erro: null });
      expect(resultados.get(2)).toMatchObject({
        inserida: false,
        situacao: 'Erro: duplicada',
      });
      expect(resultados.get(3)).toMatchObject({
        inserida: false,
        erro: 'Hinova não retornou resultado para esta foto',
      });
    });

    it('retorno vazio não marca nenhuma foto como enviada', () => {
      const enviadas = [foto(1)];
      const resultados = resultadosIniciais(enviadas);
      aplicarRetorno(enviadas, [], resultados);
      expect(resultados.get(1)?.inserida).toBe(false);
    });
  });

  it.each([
    [0, 0, 'FALHA'],
    [2, 0, 'FALHA'],
    [2, 1, 'PARCIAL'],
    [2, 2, 'ENVIADA'],
  ])('statusDoEnvio(%i fotos, %i inseridas) = %s', (total, inseridas, s) => {
    expect(statusDoEnvio(total, inseridas)).toBe(s);
  });

  it('resumirResposta guarda nome e situação, nunca o binário', () => {
    expect(
      resumirResposta([
        { nome_arquivo: 'a.jpg', situacao: 'Inserido', binario: 'AAAA' },
      ]),
    ).toEqual([{ nome_arquivo: 'a.jpg', situacao: 'Inserido' }]);
    expect(resumirResposta({ mensagem: 'bloqueado' })).toEqual({
      raw: '{"mensagem":"bloqueado"}',
    });
  });

  it('truncar corta no limite e preserva null', () => {
    expect(truncar('abcdef', 3)).toBe('abc');
    expect(truncar(null, 3)).toBeNull();
  });

  describe('resultado incerto', () => {
    it.each([
      [new Error('timeout of 60000ms exceeded'), true],
      [Object.assign(new Error('x'), { code: 'ECONNRESET' }), true],
      [Object.assign(new Error('x'), { tipo: 'timeout' }), true],
      [Object.assign(new Error('x'), { tipo: 'circuito_aberto' }), false],
      [Object.assign(new Error('x'), { tipo: 'nao_configurada' }), false],
      [new Error('Falha no login da Hinova'), false],
    ])('%s → incerto? %s', (erro, esperado) => {
      expect(falhaComResultadoIncerto(erro)).toBe(esperado);
    });

    it('timeout avisa que a foto pode ter sido gravada no SGA', () => {
      const texto = descreverFalhaDaChamada(
        new Error('timeout of 60000ms exceeded'),
      );
      expect(texto).toContain('resultado indeterminado');
      expect(texto).toContain('timeout of 60000ms exceeded');
    });

    it('falha antes do envio não leva o aviso', () => {
      expect(
        descreverFalhaDaChamada(new Error('Falha no login da Hinova')),
      ).toBe('Falha na chamada à Hinova: Falha no login da Hinova');
    });

    it('HTTP 5xx leva o aviso; 4xx não', () => {
      expect(descreverRespostaInvalida(504, 'gateway')).toContain(
        'resultado indeterminado',
      );
      expect(descreverRespostaInvalida(403, { m: 'x' })).toBe(
        'Hinova respondeu HTTP 403: {"m":"x"}',
      );
    });
  });
});
