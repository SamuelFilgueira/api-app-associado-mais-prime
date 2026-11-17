import {
  SorteFase,
  SorteMecanica,
  SorteRodadaEstado,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  diaSaoPaulo,
  proximaViradaDoDia,
  somarDias,
} from 'src/associado-sorte/helpers/sorte-data.helper';
import {
  calcularFase,
  calcularSequencia,
  gerarCodigo,
  linkWhatsapp,
  mascararCpf,
  motivoRodadaFechada,
  nomePublico,
  normalizarTelefone,
  proximoMarco,
  Semaforo,
  sortearFaixa,
  sortearGanhadores,
  validarFaixas,
} from 'src/associado-sorte/helpers/sorte.helpers';

const agora = new Date('2026-11-12T15:00:00.000Z');
const minutos = (n: number) => new Date(agora.getTime() + n * 60_000);

const rodada = (extra: object = {}) => ({
  estado: SorteRodadaEstado.PUBLICADA,
  mecanica: SorteMecanica.CORRIDA,
  abertura: minutos(-10),
  encerramento: minutos(10),
  quantidadeRestante: 1,
  ...extra,
});

describe('calcularFase', () => {
  it('EM_BREVE antes da abertura e ABERTA dentro da janela', () => {
    expect(calcularFase(rodada({ abertura: minutos(1) }), agora)).toBe(
      SorteFase.EM_BREVE,
    );
    expect(calcularFase(rodada(), agora)).toBe(SorteFase.ABERTA);
  });

  it('a abertura é inclusiva: no instante exato já está ABERTA', () => {
    expect(calcularFase(rodada({ abertura: agora }), agora)).toBe(
      SorteFase.ABERTA,
    );
  });

  it('corrida sem unidades fica ESGOTADA até o encerramento, depois ENCERRADA', () => {
    const esgotada = rodada({ quantidadeRestante: 0 });
    expect(calcularFase(esgotada, agora)).toBe(SorteFase.ESGOTADA);
    expect(
      calcularFase({ ...esgotada, estado: SorteRodadaEstado.ENCERRADA }, agora),
    ).toBe(SorteFase.ESGOTADA);
    expect(
      calcularFase({ ...esgotada, encerramento: minutos(-1) }, agora),
    ).toBe(SorteFase.ENCERRADA);
  });

  it('sorteio vencido aparece APURANDO mesmo antes do job', () => {
    const sorteio = rodada({
      mecanica: SorteMecanica.SORTEIO,
      encerramento: minutos(-1),
    });
    expect(calcularFase(sorteio, agora)).toBe(SorteFase.APURANDO);
    expect(
      calcularFase({ ...sorteio, estado: SorteRodadaEstado.ENCERRADA }, agora),
    ).toBe(SorteFase.ENCERRADA);
  });
});

describe('motivoRodadaFechada', () => {
  it('devolve o código de cada recusa e null quando aberta', () => {
    expect(motivoRodadaFechada(rodada(), agora)).toBeNull();
    expect(
      motivoRodadaFechada(rodada({ abertura: minutos(1) }), agora)?.code,
    ).toBe('RODADA_NAO_ABERTA');
    expect(
      motivoRodadaFechada(rodada({ quantidadeRestante: 0 }), agora)?.code,
    ).toBe('ESGOTADO');
    expect(
      motivoRodadaFechada(rodada({ encerramento: minutos(-1) }), agora)?.code,
    ).toBe('RODADA_ENCERRADA');
    expect(
      motivoRodadaFechada(
        rodada({ estado: SorteRodadaEstado.CANCELADA }),
        agora,
      )?.code,
    ).toBe('RODADA_ENCERRADA');
    expect(
      motivoRodadaFechada(
        rodada({ estado: SorteRodadaEstado.ENCERRADA, quantidadeRestante: 0 }),
        agora,
      )?.code,
    ).toBe('ESGOTADO');
  });
});

describe('raspadinha', () => {
  const faixas = [
    { creditos: 1, peso: 60 },
    { creditos: 3, peso: 30 },
    { creditos: 10, peso: 10 },
  ];

  it('sorteia a faixa pelo peso acumulado', () => {
    expect(sortearFaixa(faixas, () => 0)).toBe(1);
    expect(sortearFaixa(faixas, () => 59)).toBe(1);
    expect(sortearFaixa(faixas, () => 60)).toBe(3);
    expect(sortearFaixa(faixas, () => 89)).toBe(3);
    expect(sortearFaixa(faixas, () => 90)).toBe(10);
    expect(sortearFaixa(faixas, () => 99)).toBe(10);
  });

  it('pede um inteiro no intervalo do peso total', () => {
    const aleatorio = jest.fn().mockReturnValue(0);
    sortearFaixa(faixas, aleatorio);
    expect(aleatorio).toHaveBeenCalledWith(100);
  });

  it('valida faixas vazias, repetidas e com peso inválido', () => {
    expect(validarFaixas(faixas)).toBeNull();
    expect(validarFaixas([])).toMatch(/ao menos uma faixa/);
    expect(
      validarFaixas([
        { creditos: 1, peso: 1 },
        { creditos: 1, peso: 2 },
      ]),
    ).toMatch(/repetida/);
    expect(validarFaixas([{ creditos: 1, peso: 0 }])).toMatch(/peso/);
  });
});

describe('sequência de dias', () => {
  const marcos = [
    { dias: 3, bonus: 2 },
    { dias: 7, bonus: 10 },
  ];
  const calc = (ultimoDia: string | null, sequenciaAnterior: number) =>
    calcularSequencia({
      hoje: '2026-11-12',
      ultimoDia,
      sequenciaAnterior,
      marcos,
    });

  it('primeira coleta começa em 1', () => {
    expect(calc(null, 0)).toEqual({ sequencia: 1, bonus: 0 });
  });

  it('dia seguinte soma 1 e paga o bônus no marco', () => {
    expect(calc('2026-11-11', 1)).toEqual({ sequencia: 2, bonus: 0 });
    expect(calc('2026-11-11', 2)).toEqual({ sequencia: 3, bonus: 2 });
    expect(calc('2026-11-11', 6)).toEqual({ sequencia: 7, bonus: 10 });
  });

  it('pular um dia volta para 1', () => {
    expect(calc('2026-11-10', 5)).toEqual({ sequencia: 1, bonus: 0 });
  });

  it('depois do maior marco, recomeça no dia seguinte', () => {
    expect(calc('2026-11-11', 7)).toEqual({ sequencia: 1, bonus: 0 });
  });

  it('próximo marco considera a sequência viva', () => {
    const base = { hoje: '2026-11-12', marcos };
    expect(
      proximoMarco({ ...base, ultimoDia: '2026-11-12', sequencia: 2 }),
    ).toEqual({ dias: 3, bonus: 2, faltam: 1 });
    expect(
      proximoMarco({ ...base, ultimoDia: '2026-11-09', sequencia: 5 }),
    ).toEqual({ dias: 3, bonus: 2, faltam: 3 });
    expect(
      proximoMarco({ ...base, ultimoDia: '2026-11-12', sequencia: 7 }),
    ).toEqual({ dias: 3, bonus: 2, faltam: 3 });
  });
});

describe('sortearGanhadores', () => {
  const participantes = [
    { userId: 1, bilhetes: 1 },
    { userId: 2, bilhetes: 3 },
    { userId: 3, bilhetes: 6 },
  ];

  it('ganhadores são sempre distintos', () => {
    const ganhadores = sortearGanhadores(participantes, 3, () => 0);
    expect(ganhadores).toEqual([1, 2, 3]);
    expect(new Set(ganhadores).size).toBe(3);
  });

  it('a chance é proporcional aos bilhetes', () => {
    // Total 10: ponto 0 → #1 (1 bilhete); 1..3 → #2 (3); 4..9 → #3 (6).
    expect(sortearGanhadores(participantes, 1, () => 0)).toEqual([1]);
    expect(sortearGanhadores(participantes, 1, () => 1)).toEqual([2]);
    expect(sortearGanhadores(participantes, 1, () => 3)).toEqual([2]);
    expect(sortearGanhadores(participantes, 1, () => 4)).toEqual([3]);
    expect(sortearGanhadores(participantes, 1, () => 9)).toEqual([3]);
  });

  it('a cada sorteado o total de bilhetes diminui (sem reposição)', () => {
    const aleatorio = jest.fn().mockReturnValue(0);
    sortearGanhadores(participantes, 2, aleatorio);
    expect(aleatorio).toHaveBeenNthCalledWith(1, 10);
    expect(aleatorio).toHaveBeenNthCalledWith(2, 9);
  });

  it('menos inscritos que unidades: todos ganham; sem inscritos: ninguém', () => {
    expect(sortearGanhadores(participantes, 5, () => 0)).toHaveLength(3);
    expect(sortearGanhadores([], 2, () => 0)).toEqual([]);
  });
});

describe('apresentação', () => {
  it('nome público mostra primeiro nome e inicial do sobrenome', () => {
    expect(nomePublico('samuel de souza filgueira')).toBe('Samuel F.');
    expect(nomePublico('MARIA')).toBe('Maria');
    expect(nomePublico('')).toBe('Associado');
  });

  it('mascara o CPF', () => {
    expect(mascararCpf('12345678909')).toBe('***.456.789-**');
    expect(mascararCpf('123')).toBe('***.***.***-**');
  });

  it('normaliza telefone para o wa.me e recusa número curto', () => {
    expect(normalizarTelefone('(21) 99999-8888')).toBe('5521999998888');
    expect(normalizarTelefone('5521999998888')).toBe('5521999998888');
    expect(normalizarTelefone('2133334444')).toBe('552133334444');
    expect(normalizarTelefone('123')).toBeNull();
    expect(normalizarTelefone(null)).toBeNull();
  });

  it('monta o link wa.me com a mensagem codificada', () => {
    expect(linkWhatsapp('21999998888', 'Olá, código AB12')).toBe(
      'https://wa.me/5521999998888?text=Ol%C3%A1%2C%20c%C3%B3digo%20AB12',
    );
    expect(linkWhatsapp(null, 'x')).toBeNull();
  });

  it('código do prêmio tem 6 caracteres sem símbolos ambíguos', () => {
    let n = 0;
    const codigo = gerarCodigo(() => n++);
    expect(codigo).toHaveLength(6);
    expect(codigo).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
  });
});

describe('dia em São Paulo', () => {
  it('usa o fuso de Brasília, não o UTC', () => {
    // 02:30Z do dia 13 ainda é 23:30 do dia 12 em São Paulo.
    expect(diaSaoPaulo(new Date('2026-11-13T02:30:00.000Z'))).toBe(
      '2026-11-12',
    );
    expect(diaSaoPaulo(new Date('2026-11-13T03:00:00.000Z'))).toBe(
      '2026-11-13',
    );
  });

  it('soma dias atravessando o mês e calcula a virada do dia', () => {
    expect(somarDias('2026-11-30', 1)).toBe('2026-12-01');
    expect(
      proximaViradaDoDia(new Date('2026-11-13T02:30:00.000Z')).toISOString(),
    ).toBe('2026-11-13T03:00:00.000Z');
  });
});

describe('Semaforo', () => {
  it('nunca deixa passar mais que o limite ao mesmo tempo', async () => {
    const semaforo = new Semaforo(2);
    let simultaneos = 0;
    let pico = 0;
    const tarefa = async () => {
      const liberar = await semaforo.adquirir();
      simultaneos++;
      pico = Math.max(pico, simultaneos);
      await new Promise((r) => setTimeout(r, 5));
      simultaneos--;
      liberar();
    };
    await Promise.all(Array.from({ length: 8 }, tarefa));
    expect(pico).toBe(2);
    expect(simultaneos).toBe(0);
  });
});
