import {
  agruparPorAssociado,
  elegiveisDaEtapa,
  IDADE_MINIMA_DO_ORFAO_MS,
  LogExistente,
  prepararBoletos,
  selecionarDestinatarios,
  situacaoDoLog,
  UsuarioDoApp,
  usuariosDaBase,
} from 'src/boleto-notificacao/domain/regua-elegibilidade';
import { janelaDaEtapa } from 'src/boleto-notificacao/domain/regua-janelas';
import { SgaBoletoPeriodo } from 'src/boleto-notificacao/interfaces/sga-boleto-periodo.interface';

const REGRAS = {
  offsets: { DM5: 5, D0: 0, D1: 1, D5: 5, D6: 6, D20: 20 },
  alcanceD20: 40,
};
const DIA_10 = new Date(2026, 8, 10);
const AGORA = new Date('2026-09-10T14:00:00.000Z');
const haMinutos = (min: number) => new Date(AGORA.getTime() - min * 60_000);
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const MODELO = { titulo: 'Vence em {data}', corpo: '{nome}, placa {placa}' };

function boleto(overrides: Partial<SgaBoletoPeriodo> = {}): SgaBoletoPeriodo {
  return {
    nossoNumero: '1',
    codigoAssociado: 55,
    nomeAssociado: 'KAIO DA SILVA',
    cpf: '529.982.247-25',
    dataVencimento: '2026-09-10',
    dataVencimentoOriginal: '2026-09-10',
    codigoSituacaoBoleto: '2',
    codigoTipoBoleto: '1',
    tipoBoleto: 'MENSALIDADE',
    situacaoBoleto: 'ABERTO',
    valorBoleto: '99.90',
    mesReferente: '09/2026',
    veiculos: [{ codigo_veiculo: 1, placa: 'ABC1D23' }],
    ...overrides,
  };
}

function log(overrides: Partial<LogExistente> = {}): LogExistente {
  return {
    id: 1,
    codigoAssociado: 55,
    dataVencimentoOriginal: new Date('2026-09-10T00:00:00.000Z'),
    statusEnvio: 'ENFILEIRADO',
    expoTicketId: null,
    expoErro: null,
    atualizadoEm: haMinutos(30),
    ...overrides,
  };
}

const usuario = (overrides: Partial<UsuarioDoApp> = {}): UsuarioDoApp => ({
  id: 1,
  cpf: '52998224725',
  baseOrigin: 'MAIS_PRIME',
  expoPushToken: TOKEN,
  ...overrides,
});

describe('situacaoDoLog — o log ainda vale como "já notificado"?', () => {
  it.each([
    ['ENVIADO', { statusEnvio: 'ENVIADO', expoTicketId: 't1' }],
    ['ENVIADO sem ticket', { statusEnvio: 'ENVIADO' }],
    ['ENTREGUE', { statusEnvio: 'ENTREGUE', expoTicketId: 't1' }],
    [
      'FALHA por token inválido',
      { statusEnvio: 'FALHA', expoErro: 'DeviceNotRegistered: aparelho' },
    ],
    [
      'FALHA por recusa do Expo',
      { statusEnvio: 'FALHA', expoErro: 'TICKET_ERROR: recusado' },
    ],
    [
      'FALHA no recibo (já tinha ticket)',
      {
        statusEnvio: 'FALHA',
        expoTicketId: 't1',
        expoErro: 'MessageRateExceeded: muitas mensagens',
      },
    ],
    ['FALHA sem descrição', { statusEnvio: 'FALHA', expoErro: null }],
    [
      'ENFILEIRADO que já tem ticket',
      { statusEnvio: 'ENFILEIRADO', expoTicketId: 't1' },
    ],
    ['estado desconhecido', { statusEnvio: undefined }],
  ])('%s: definitivo, não reenvia', (_nome, campos) => {
    expect(situacaoDoLog(log(campos), AGORA)).toBe('definitivo');
  });

  it('ENFILEIRADO sem ticket e antigo: órfão, volta a ser elegível', () => {
    expect(situacaoDoLog(log({ atualizadoEm: haMinutos(6) }), AGORA)).toBe(
      'reenviavel',
    );
  });

  it('ENFILEIRADO na idade mínima exata já é órfão; um milissegundo antes, não', () => {
    const noLimite = new Date(AGORA.getTime() - IDADE_MINIMA_DO_ORFAO_MS);
    const quase = new Date(noLimite.getTime() + 1);
    expect(situacaoDoLog(log({ atualizadoEm: noLimite }), AGORA)).toBe(
      'reenviavel',
    );
    expect(situacaoDoLog(log({ atualizadoEm: quase }), AGORA)).toBe('em_envio');
  });

  it('ENFILEIRADO recente (ou sem data): pode ser de uma execução viva', () => {
    expect(situacaoDoLog(log({ atualizadoEm: haMinutos(1) }), AGORA)).toBe(
      'em_envio',
    );
    expect(situacaoDoLog(log({ atualizadoEm: null }), AGORA)).toBe('em_envio');
  });

  it('FALHA de transporte (SEND_ERROR, sem ticket): elegível na hora, sem idade mínima', () => {
    expect(
      situacaoDoLog(
        log({
          statusEnvio: 'FALHA',
          expoErro: 'SEND_ERROR: socket hang up',
          atualizadoEm: AGORA,
        }),
        AGORA,
      ),
    ).toBe('reenviavel');
  });

  it('a idade mínima é parâmetro', () => {
    const umMinuto = log({ atualizadoEm: haMinutos(1) });
    expect(situacaoDoLog(umMinuto, AGORA, 30_000)).toBe('reenviavel');
    expect(situacaoDoLog(umMinuto, AGORA, 120_000)).toBe('em_envio');
  });
});

describe('prepararBoletos / elegiveisDaEtapa / agruparPorAssociado', () => {
  it('fica só o ABERTO, do tipo permitido, e o mais recente por placa', () => {
    const { prontos, descartados } = prepararBoletos(
      [
        boleto({ nossoNumero: 'aberto' }),
        boleto({ nossoNumero: 'pago', codigoSituacaoBoleto: '1' }),
        boleto({ nossoNumero: 'quitacao', codigoTipoBoleto: '27' }),
        boleto({ nossoNumero: 'sem-data', dataVencimento: '0000-00-00' }),
        boleto({ nossoNumero: 'antigo', dataVencimento: '2026-08-10' }),
      ],
      ['1', '5'],
    );

    expect(prontos.map((b) => b.nossoNumero)).toEqual(['aberto']);
    expect(descartados.map((b) => b.nossoNumero)).toEqual(['antigo']);
  });

  it('sem filtro de tipo configurado, todos os tipos entram', () => {
    const { prontos } = prepararBoletos(
      [
        boleto({ nossoNumero: 'a' }),
        boleto({
          nossoNumero: 'b',
          codigoTipoBoleto: '27',
          veiculos: [{ placa: 'ZZZ0Z00' }],
        }),
      ],
      [],
    );
    expect(prontos.map((b) => b.nossoNumero)).toEqual(['a', 'b']);
  });

  it('contrato suspenso só filtra em D+6 e D+20, sem diferenciar maiúsculas', () => {
    const ativo = boleto({
      nossoNumero: 'ativo',
      dataVencimento: '2026-09-04',
      veiculos: [{ placa: 'AAA0A00', situacao_veiculo: 'ATIVO' }],
    });
    const inadimplente = boleto({
      nossoNumero: 'inad',
      dataVencimento: '2026-09-04',
      veiculos: [{ placa: 'BBB0B00', situacao_veiculo: ' inadimplente ' }],
    });
    const d6 = janelaDaEtapa(DIA_10, 'D6', REGRAS);
    const d1 = janelaDaEtapa(new Date(2026, 8, 5), 'D1', REGRAS);

    expect(
      elegiveisDaEtapa([ativo, inadimplente], d6, 'D6', ['Inadimplente']).map(
        (b) => b.nossoNumero,
      ),
    ).toEqual(['inad']);
    expect(
      elegiveisDaEtapa([ativo, inadimplente], d6, 'D6', []).map(
        (b) => b.nossoNumero,
      ),
    ).toEqual(['ativo', 'inad']);
    expect(
      elegiveisDaEtapa([ativo, inadimplente], d1, 'D1', ['INADIMPLENTE']).map(
        (b) => b.nossoNumero,
      ),
    ).toEqual(['ativo', 'inad']);
  });

  it('agrupa por associado × vencimento, normaliza o CPF e separa quem não tem identificação', () => {
    const { grupos, semIdentificacao } = agruparPorAssociado([
      boleto({ nossoNumero: '1' }),
      boleto({ nossoNumero: '2' }),
      boleto({ nossoNumero: '3', dataVencimento: '2026-09-15' }),
      boleto({ nossoNumero: '4', codigoAssociado: null }),
      boleto({ nossoNumero: '5', codigoAssociado: 66, cpf: '' }),
      boleto({ nossoNumero: '6', codigoAssociado: 77, cpf: '58034733000127' }),
    ]);

    expect(semIdentificacao).toBe(2);
    expect(
      grupos.map((g) => [
        g.codigoAssociado,
        g.cpf,
        g.vencimento.getDate(),
        g.boletos.map((b) => b.nossoNumero),
      ]),
    ).toEqual([
      [55, '52998224725', 10, ['1', '2']],
      [55, '52998224725', 15, ['3']],
      [77, '58034733000127', 10, ['6']],
    ]);
  });

  it('usuário de outra base fica de fora; sem base no cadastro entra', () => {
    const { porCpf, deOutraBase } = usuariosDaBase(
      [
        usuario({ id: 1, cpf: '1' }),
        usuario({ id: 2, cpf: '2', baseOrigin: null }),
        usuario({ id: 3, cpf: '3', baseOrigin: 'MAIS_PRIME_RS' }),
      ],
      'MAIS_PRIME',
    );
    expect(Array.from(porCpf.keys())).toEqual(['1', '2']);
    expect(deOutraBase).toBe(1);
  });
});

describe('selecionarDestinatarios', () => {
  /** CPF de 11 dígitos (o agrupamento normaliza com zeros à esquerda). */
  const cpf = (n: number) => String(n).padStart(11, '0');
  const grupoDe = (codigoAssociado: number, cpf: string) =>
    agruparPorAssociado([boleto({ codigoAssociado, cpf })]).grupos[0];
  const selecionar = (
    grupos: ReturnType<typeof grupoDe>[],
    usuarios: UsuarioDoApp[],
    logs: LogExistente[] = [],
  ) =>
    selecionarDestinatarios({
      grupos,
      usuarioPorCpf: new Map(usuarios.map((u) => [u.cpf, u])),
      logs,
      tokenValido: (token) =>
        typeof token === 'string' && token.startsWith('ExponentPushToken['),
      modelo: MODELO,
      agora: AGORA,
    });

  it('monta o destinatário com os textos renderizados', () => {
    const selecao = selecionar([grupoDe(55, '52998224725')], [usuario()]);

    expect(selecao.destinatarios).toHaveLength(1);
    expect(selecao.destinatarios[0]).toMatchObject({
      codigoAssociado: 55,
      cpf: '52998224725',
      userId: 1,
      expoPushToken: TOKEN,
      titulo: 'Vence em 10/09',
      corpo: 'Kaio, placa ABC1D23',
    });
    expect(selecao.destinatarios[0].logParaRetomar).toBeUndefined();
  });

  it('classifica: já notificado, em envio, sem usuário, sem token, token inválido e usuário repetido', () => {
    const selecao = selecionar(
      [
        grupoDe(1, cpf(1)), // já enviado
        grupoDe(2, cpf(2)), // ENFILEIRADO recente de outra execução
        grupoDe(3, cpf(3)), // sem cadastro no app
        grupoDe(4, cpf(4)), // sem token
        grupoDe(5, cpf(5)), // token com formato inválido
        grupoDe(6, cpf(6)), // recebe
        grupoDe(7, cpf(6)), // mesmo usuário (CPF) em outro código de associado
      ],
      [
        usuario({ id: 1, cpf: cpf(1) }),
        usuario({ id: 2, cpf: cpf(2) }),
        usuario({ id: 4, cpf: cpf(4), expoPushToken: null }),
        usuario({ id: 5, cpf: cpf(5), expoPushToken: 'token-qualquer' }),
        usuario({ id: 6, cpf: cpf(6) }),
      ],
      [
        log({ id: 10, codigoAssociado: 1, statusEnvio: 'ENVIADO' }),
        log({ id: 11, codigoAssociado: 2, atualizadoEm: haMinutos(1) }),
      ],
    );

    expect(selecao.destinatarios.map((d) => d.codigoAssociado)).toEqual([6]);
    expect(selecao).toMatchObject({
      idempotentes: 2,
      emEnvio: 1,
      semUsuario: 1,
      semToken: 2,
      duplicadosUsuario: 1,
    });
  });

  it('log órfão ou com falha de transporte: o grupo volta a receber e leva o log para retomar', () => {
    const orfao = log({ id: 10, codigoAssociado: 1 });
    const semResposta = log({
      id: 11,
      codigoAssociado: 2,
      statusEnvio: 'FALHA',
      expoErro: 'SEND_ERROR: timeout',
    });
    const selecao = selecionar(
      [grupoDe(1, cpf(1)), grupoDe(2, cpf(2))],
      [usuario({ id: 1, cpf: cpf(1) }), usuario({ id: 2, cpf: cpf(2) })],
      [orfao, semResposta],
    );

    expect(selecao.idempotentes).toBe(0);
    expect(selecao.destinatarios.map((d) => d.logParaRetomar)).toEqual([
      orfao,
      semResposta,
    ]);
  });

  it('log reenviável de quem ficou sem token: não recebe, conta como sem token', () => {
    const selecao = selecionar(
      [grupoDe(1, cpf(1))],
      [usuario({ id: 1, cpf: cpf(1), expoPushToken: null })],
      [log({ id: 10, codigoAssociado: 1 })],
    );

    expect(selecao.destinatarios).toEqual([]);
    expect(selecao).toMatchObject({ idempotentes: 0, semToken: 1 });
  });

  it('o log só vale para o MESMO vencimento do grupo', () => {
    const selecao = selecionar(
      [grupoDe(1, cpf(1))],
      [usuario({ id: 1, cpf: cpf(1) })],
      [
        log({
          codigoAssociado: 1,
          statusEnvio: 'ENVIADO',
          dataVencimentoOriginal: new Date('2026-08-10T00:00:00.000Z'),
        }),
      ],
    );
    expect(selecao.destinatarios).toHaveLength(1);
    expect(selecao.idempotentes).toBe(0);
  });
});
