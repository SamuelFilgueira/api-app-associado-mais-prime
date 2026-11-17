import {
  dividirLinhaCsv,
  hashCronograma,
  lerCreditos,
  lerCronogramaCsv,
  revalidarCronograma,
  lerDataHoraBrasilia,
  textoCanonicoDoCronograma,
} from 'src/associado-sorte/helpers/sorte-cronograma.helper';

describe('lerCronogramaCsv (planilha do cronograma)', () => {
  const periodo = {
    inicio: new Date('2026-11-01T03:00:00.000Z'),
    fim: new Date('2026-12-01T03:00:00.000Z'),
  };

  it('lê o formato padrão com ; e converte o horário de Brasília', () => {
    const r = lerCronogramaCsv(
      'data;hora;creditos;descricao\n20/11/2026;15:00;120;Voucher da tarde\n21/11/2026;09:05;200;',
      { periodo },
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas).toEqual([
      {
        linha: 2,
        liberaEm: new Date('2026-11-20T18:00:00.000Z'),
        creditos: 120,
        descricao: 'Voucher da tarde',
      },
      {
        linha: 3,
        liberaEm: new Date('2026-11-21T12:05:00.000Z'),
        creditos: 200,
        descricao: null,
      },
    ]);
  });

  it('aceite , como separador, cabeçalho em outra ordem, maiúsculas/acentos, BOM e CRLF', () => {
    const r = lerCronogramaCsv(
      '\uFEFFCréditos,Descrição,HORA,Data\r\n150,"Voucher, com vírgula",15:30,22/11/2026\r\n\r\n',
      { periodo },
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]).toMatchObject({
      creditos: 150,
      descricao: 'Voucher, com vírgula',
      liberaEm: new Date('2026-11-22T18:30:00.000Z'),
    });
  });

  it('descrição é opcional (cabeçalho sem a coluna)', () => {
    const r = lerCronogramaCsv('data;hora;creditos\n20/11/2026;15:00;120');
    expect(r.erros).toEqual([]);
    expect(r.linhas[0].descricao).toBeNull();
  });

  it('recusa cabeçalho sem coluna obrigatória', () => {
    const r = lerCronogramaCsv('data;creditos\n20/11/2026;120');
    expect(r.linhas).toEqual([]);
    expect(r.erros[0]).toMatchObject({ linha: 1 });
    expect(r.erros[0].mensagem).toContain('hora');
  });

  it('aponta erro por linha (data, hora, créditos, período) sem descartar as boas', () => {
    const r = lerCronogramaCsv(
      [
        'data;hora;creditos;descricao',
        '2026-11-20;15:00;120;formato ISO',
        '20/11/2026;25:00;120;hora inválida',
        '31/02/2026;10:00;120;dia inexistente',
        '20/11/2026;15:00;0;zero',
        '20/11/2026;15:00;12,5;decimal',
        '20/11/2027;15:00;120;fora do período',
        '20/11/2026;16:00;150;boa',
      ].join('\n'),
      { periodo },
    );
    expect(r.linhas.map((l) => l.linha)).toEqual([8]);
    expect(r.erros.map((e) => e.linha)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(r.erros[0].mensagem).toContain('data inválida');
    expect(r.erros[1].mensagem).toContain('hora inválida');
    expect(r.erros[2].mensagem).toContain('inexistente');
    expect(r.erros[3].mensagem).toContain('créditos inválidos');
    expect(r.erros[4].mensagem).toContain('créditos inválidos');
    expect(r.erros[5].mensagem).toContain('fora do período');
  });

  it('recusa linha duplicada (e contra os momentos que já existem)', () => {
    const r = lerCronogramaCsv(
      'data;hora;creditos;descricao\n20/11/2026;15:00;120;A\n20/11/2026;15:00;120;a\n20/11/2026;15:00;200;A\n20/11/2026;17:00;120;B',
      {
        existentes: [
          {
            liberaEm: new Date('2026-11-20T20:00:00.000Z'),
            creditos: 120,
            descricao: 'B',
          },
        ],
      },
    );
    expect(r.linhas.map((l) => l.linha)).toEqual([2, 4]);
    expect(r.erros).toEqual([
      { linha: 3, mensagem: 'linha duplicada (igual à linha 2)' },
      { linha: 5, mensagem: 'momento já existe no cronograma' },
    ]);
  });

  it('arquivo vazio ou só com cabeçalho é erro', () => {
    expect(lerCronogramaCsv('').erros).toHaveLength(1);
    expect(lerCronogramaCsv('data;hora;creditos').erros[0].mensagem).toBe(
      'Nenhum momento no arquivo',
    );
  });

  it('respeita o limite de linhas', () => {
    const csv = ['data;hora;creditos', ...Array(5).fill('20/11/2026;15:00;1')]
      .map((l, i) => (i > 0 ? l.replace('15:00', `15:0${i}`) : l))
      .join('\n');
    const r = lerCronogramaCsv(csv, { maxLinhas: 3 });
    expect(r.linhas).toHaveLength(3);
    expect(r.erros[0].mensagem).toContain('limite de 3 linhas');
  });

  it('lê o layout oficial (títulos, Dia;Horário;Prêmio, segundos, "Voucher R$120")', () => {
    const r = lerCronogramaCsv(
      [
        'Associado da Sorte · Cronograma de prêmios;;',
        'Promotora: Mais Prime · Período: 14/12/2026 a 13/12/2027;;',
        'Dia;Horário;Prêmio',
        '14/12/2026;09:40:31;Voucher R$120',
        '30/12/2026;19:10:29;Voucher R$200',
      ].join('\n'),
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas).toEqual([
      {
        linha: 4,
        liberaEm: new Date('2026-12-14T12:40:31.000Z'),
        creditos: 120,
        descricao: 'Voucher R$120',
      },
      {
        linha: 5,
        liberaEm: new Date('2026-12-30T22:10:29.000Z'),
        creditos: 200,
        descricao: 'Voucher R$200',
      },
    ]);
  });

  it('recusa segundos inválidos', () => {
    const r = lerCronogramaCsv(
      'dia;horario;premio\n14/12/2026;09:40:61;Voucher R$120',
    );
    expect(r.erros[0].mensagem).toContain('hora inválida');
  });

  it('lerCreditos aceita número puro, R$ e rótulo do prêmio; recusa centavos', () => {
    expect(lerCreditos('120')).toBe(120);
    expect(lerCreditos('Voucher R$120')).toBe(120);
    expect(lerCreditos('R$ 1.200,00')).toBe(1200);
    expect(lerCreditos('R$ 89,90')).toBeNaN();
    expect(lerCreditos('voucher')).toBeNaN();
  });

  it('revalidarCronograma reaplica período e duplicidade sobre linhas já lidas', () => {
    const lido = lerCronogramaCsv(
      'data;hora;creditos\n20/11/2026;15:00:30;120\n20/11/2027;15:00;120',
    );
    expect(lido.erros).toEqual([]);
    const r = revalidarCronograma(lido.linhas, { periodo });
    expect(r.linhas.map((l) => l.liberaEm)).toEqual([
      new Date('2026-11-20T18:00:30.000Z'),
    ]);
    expect(r.erros).toEqual([
      { linha: 3, mensagem: 'horário fora do período da campanha' },
    ]);
  });

  it('dividirLinhaCsv respeita aspas e aspas escapadas', () => {
    expect(dividirLinhaCsv('a;"b;c";"d ""e"""', ';')).toEqual([
      'a',
      'b;c',
      'd "e"',
    ]);
  });

  it('lerDataHoraBrasilia usa o offset -03:00', () => {
    expect(lerDataHoraBrasilia('01/01/2027', '00:00')).toEqual(
      new Date('2027-01-01T03:00:00.000Z'),
    );
    expect(lerDataHoraBrasilia('29/02/2027', '00:00')).toBeNull();
  });
});

describe('hashCronograma', () => {
  const campanha = {
    id: 7,
    baseOrigin: 'MAIS_PRIME',
    inicio: new Date('2026-11-01T03:00:00.000Z'),
    fim: new Date('2026-12-01T03:00:00.000Z'),
  };
  const momentos = [
    {
      id: 2,
      liberaEm: new Date('2026-11-20T18:00:00.000Z'),
      creditos: 150,
      descricao: 'B',
    },
    {
      id: 1,
      liberaEm: new Date('2026-11-20T18:00:00.000Z'),
      creditos: 120,
      descricao: 'A',
    },
  ];

  it('texto canônico ordena por liberaEm e id', () => {
    expect(textoCanonicoDoCronograma(campanha, momentos)).toBe(
      [
        'campanha=7',
        'base=MAIS_PRIME',
        'inicio=2026-11-01T03:00:00.000Z',
        'fim=2026-12-01T03:00:00.000Z',
        '2026-11-20T18:00:00.000Z;120;A',
        '2026-11-20T18:00:00.000Z;150;B',
      ].join('\n'),
    );
  });

  it('é estável e muda com qualquer alteração do cronograma', () => {
    const h = hashCronograma(campanha, momentos);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCronograma(campanha, [...momentos].reverse())).toBe(h);
    expect(
      hashCronograma(campanha, [
        { ...momentos[0], creditos: 151 },
        momentos[1],
      ]),
    ).not.toBe(h);
  });
});
