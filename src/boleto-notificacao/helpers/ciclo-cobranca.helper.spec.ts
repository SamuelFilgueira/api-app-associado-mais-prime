import {
  calcularDataAlvo,
  diasEfetivosDoMes,
  isDataGatilho,
  normalizarCpf,
  renderizarMensagem,
} from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';

const params = {
  diasVencimento: [5, 10, 15, 20, 25, 30],
  fallbackMesCurto: 28,
};

describe('ciclo-cobranca.helper', () => {
  describe('diasEfetivosDoMes', () => {
    it('mantém todos os dias em meses de 30/31 dias', () => {
      expect(diasEfetivosDoMes(2026, 1, params)).toEqual([
        5, 10, 15, 20, 25, 30,
      ]);
      expect(diasEfetivosDoMes(2026, 4, params)).toEqual([
        5, 10, 15, 20, 25, 30,
      ]);
    });

    it('substitui o dia 30 por 28 em fevereiro (ano comum)', () => {
      expect(diasEfetivosDoMes(2026, 2, params)).toEqual([
        5, 10, 15, 20, 25, 28,
      ]);
    });

    it('substitui o dia 30 por 28 em fevereiro bissexto (fallback fixo, não último dia)', () => {
      expect(diasEfetivosDoMes(2028, 2, params)).toEqual([
        5, 10, 15, 20, 25, 28,
      ]);
    });

    it('respeita fallback configurável', () => {
      expect(
        diasEfetivosDoMes(2026, 2, { ...params, fallbackMesCurto: 27 }),
      ).toEqual([5, 10, 15, 20, 25, 27]);
    });

    it('não duplica quando o fallback já é um dia configurado', () => {
      expect(
        diasEfetivosDoMes(2026, 2, {
          diasVencimento: [28, 30],
          fallbackMesCurto: 28,
        }),
      ).toEqual([28]);
    });
  });

  describe('isDataGatilho', () => {
    it('reconhece dias fixos e a exceção de fevereiro', () => {
      expect(isDataGatilho(new Date(2026, 0, 30), params)).toBe(true);
      expect(isDataGatilho(new Date(2026, 0, 31), params)).toBe(false);
      expect(isDataGatilho(new Date(2026, 1, 28), params)).toBe(true); // 28/02 no lugar do 30
      expect(isDataGatilho(new Date(2026, 2, 28), params)).toBe(false); // 28/03 não é gatilho
      expect(isDataGatilho(new Date(2026, 1, 5), params)).toBe(true);
    });

    it('feriado/fim de semana não desloca: dia 5 num domingo continua gatilho', () => {
      const domingo = new Date(2026, 3, 5); // 05/04/2026 é domingo
      expect(domingo.getDay()).toBe(0);
      expect(isDataGatilho(domingo, params)).toBe(true);
    });
  });

  describe('calcularDataAlvo', () => {
    it('calcula D0, D+5 e D+6 em dias corridos cruzando o mês', () => {
      const hoje = new Date(2026, 2, 5, 15, 30); // 05/03/2026 15:30
      expect(calcularDataAlvo(hoje, 0)).toEqual(new Date(2026, 2, 5));
      expect(calcularDataAlvo(hoje, 5)).toEqual(new Date(2026, 1, 28)); // 28/02
      expect(calcularDataAlvo(hoje, 6)).toEqual(new Date(2026, 1, 27));
    });

    it('D+5 de um boleto de 28/02 (fallback do 30) dispara em 05/03', () => {
      const dataAlvo = calcularDataAlvo(new Date(2026, 2, 5), 5);
      expect(isDataGatilho(dataAlvo, params)).toBe(true);
    });
  });

  describe('normalizarCpf', () => {
    it('remove máscara e repõe zeros à esquerda', () => {
      expect(normalizarCpf('529.982.247-25')).toBe('52998224725');
      expect(normalizarCpf(1234567890)).toBe('01234567890');
      expect(normalizarCpf('')).toBeNull();
      expect(normalizarCpf('123456789012345')).toBeNull();
    });

    it('aceita CNPJ (14 dígitos) no campo cpf de associado pessoa jurídica', () => {
      expect(normalizarCpf('58034733000127')).toBe('58034733000127');
      expect(normalizarCpf('58.034.733/0001-27')).toBe('58034733000127');
    });
  });

  describe('renderizarMensagem', () => {
    it('substitui placeholders', () => {
      expect(
        renderizarMensagem('Vence em {vencimento} ({quantidade} boleto(s))', {
          vencimento: '05/03/2026',
          quantidade: 2,
        }),
      ).toBe('Vence em 05/03/2026 (2 boleto(s))');
    });
  });
});
