import {
  calcularAbertoAgora,
  calcularIniciais,
  cupomVisivel,
  derivarMelhorBeneficio,
  distanciaKm,
  mascararCpfPainel,
  montarLogradouro,
  normalizarCodigoCupom,
  parseDataCupom,
  statusCupom,
  validarHorarios,
} from 'src/direct-partners/helpers/direct-partner.helpers';
import { DirectPartnerCouponStatus } from 'src/direct-partners/enums/direct-partner.enums';

describe('direct-partner.helpers', () => {
  describe('calcularIniciais', () => {
    it('usa a primeira letra das duas primeiras palavras relevantes', () => {
      expect(calcularIniciais('Auto Center Premium')).toBe('AC');
      expect(calcularIniciais('Padaria do João')).toBe('PJ');
      expect(calcularIniciais('Casa das Baterias')).toBe('CB');
    });

    it('nome com uma palavra devolve as duas primeiras letras', () => {
      expect(calcularIniciais('Padaria')).toBe('PA');
    });

    it('ignora pontuação e nome vazio', () => {
      expect(calcularIniciais('Óticas & Cia.')).toBe('ÓC');
      expect(calcularIniciais('')).toBe('');
    });
  });

  describe('distanciaKm', () => {
    it('calcula haversine com 1 casa decimal', () => {
      // Recife (Boa Viagem) → Recife (Marco Zero) ≈ 7,3 km
      const d = distanciaKm(-8.1189, -34.8993, -8.0631, -34.8711);
      expect(d).toBeGreaterThan(6);
      expect(d).toBeLessThan(8);
      expect(Number.isInteger(d * 10)).toBe(true);
    });

    it('mesmo ponto devolve 0', () => {
      expect(distanciaKm(-8.1, -34.9, -8.1, -34.9)).toBe(0);
    });
  });

  describe('calcularAbertoAgora', () => {
    const grade = [
      { weekday: 1, opens: '08:00', closes: '18:00' }, // segunda
      { weekday: 5, opens: '22:00', closes: '02:00' }, // sexta, vira a noite
    ];

    // 2026-10-19 é segunda-feira
    const segunda = (h: number, m = 0) => new Date(2026, 9, 19, h, m);

    it('null sem grade', () => {
      expect(calcularAbertoAgora(null)).toBeNull();
      expect(calcularAbertoAgora([])).toBeNull();
    });

    it('respeita abertura inclusiva e fechamento exclusivo', () => {
      expect(calcularAbertoAgora(grade, segunda(7, 59))).toBe(false);
      expect(calcularAbertoAgora(grade, segunda(8, 0))).toBe(true);
      expect(calcularAbertoAgora(grade, segunda(17, 59))).toBe(true);
      expect(calcularAbertoAgora(grade, segunda(18, 0))).toBe(false);
    });

    it('dia sem entrada na grade é fechado', () => {
      const terca = new Date(2026, 9, 20, 10, 0);
      expect(calcularAbertoAgora(grade, terca)).toBe(false);
    });

    it('horário que atravessa a meia-noite vale na madrugada do dia seguinte', () => {
      const sexta23h = new Date(2026, 9, 23, 23, 0);
      const sabado1h = new Date(2026, 9, 24, 1, 30);
      const sabado3h = new Date(2026, 9, 24, 3, 0);
      expect(calcularAbertoAgora(grade, sexta23h)).toBe(true);
      expect(calcularAbertoAgora(grade, sabado1h)).toBe(true);
      expect(calcularAbertoAgora(grade, sabado3h)).toBe(false);
    });
  });

  describe('validarHorarios', () => {
    it('aceita grade válida e nula', () => {
      expect(validarHorarios(null)).toBeNull();
      expect(
        validarHorarios([{ weekday: 1, opens: '08:00', closes: '18:00' }]),
      ).toBeNull();
    });

    it('rejeita dia duplicado, formato inválido e abre=fecha', () => {
      expect(
        validarHorarios([
          { weekday: 1, opens: '08:00', closes: '18:00' },
          { weekday: 1, opens: '19:00', closes: '22:00' },
        ]),
      ).toMatch(/duplicado/);
      expect(
        validarHorarios([{ weekday: 1, opens: '8h', closes: '18:00' }]),
      ).toMatch(/HH:mm/);
      expect(
        validarHorarios([{ weekday: 1, opens: '08:00', closes: '08:00' }]),
      ).toMatch(/iguais/);
    });
  });

  describe('statusCupom / cupomVisivel', () => {
    const agora = new Date(2026, 9, 19, 12, 0);
    const base = { isActive: true, validFrom: null as Date | null };

    it('VISIVEL quando ativo e dentro do período (fim do dia inclusivo)', () => {
      const cupom = { ...base, validUntil: new Date(2026, 9, 19) };
      expect(statusCupom(cupom, agora)).toBe(DirectPartnerCouponStatus.VISIVEL);
      expect(cupomVisivel(cupom, agora)).toBe(true);
    });

    it('VENCIDO no dia seguinte ao validUntil', () => {
      const cupom = { ...base, validUntil: new Date(2026, 9, 18) };
      expect(statusCupom(cupom, agora)).toBe(DirectPartnerCouponStatus.VENCIDO);
    });

    it('AGENDADO quando validFrom é futuro', () => {
      const cupom = {
        ...base,
        validFrom: new Date(2026, 9, 20),
        validUntil: new Date(2026, 11, 31),
      };
      expect(statusCupom(cupom, agora)).toBe(
        DirectPartnerCouponStatus.AGENDADO,
      );
    });

    it('INATIVO prevalece sobre a validade', () => {
      const cupom = {
        isActive: false,
        validFrom: null,
        validUntil: new Date(2026, 11, 31),
      };
      expect(statusCupom(cupom, agora)).toBe(DirectPartnerCouponStatus.INATIVO);
    });
  });

  describe('parseDataCupom', () => {
    it('yyyy-mm-dd vira meia-noite local', () => {
      const d = parseDataCupom('2026-12-31');
      expect(d?.getFullYear()).toBe(2026);
      expect(d?.getMonth()).toBe(11);
      expect(d?.getDate()).toBe(31);
      expect(d?.getHours()).toBe(0);
    });

    it('nulo/inválido devolve null', () => {
      expect(parseDataCupom(null)).toBeNull();
      expect(parseDataCupom('abc')).toBeNull();
    });
  });

  describe('montarLogradouro', () => {
    it('concatena número e complemento quando existem', () => {
      expect(
        montarLogradouro({
          street: 'Av. X',
          number: '1234',
          complement: 'Sala 2',
        }),
      ).toBe('Av. X, 1234 – Sala 2');
    });

    it('sem número não sobra vírgula', () => {
      expect(
        montarLogradouro({
          street: 'Av. X',
          number: null,
          complement: 'Quiosque 3',
        }),
      ).toBe('Av. X – Quiosque 3');
      expect(montarLogradouro({ street: 'Av. X', number: '  ' })).toBe('Av. X');
    });
  });

  describe('derivarMelhorBeneficio', () => {
    it('usa o maior percentual', () => {
      expect(derivarMelhorBeneficio(['10%', 'Grátis', '20%'])).toEqual({
        melhorBeneficio: 'até 20%',
        textoDesconto: 'Até 20% de desconto',
      });
    });

    it('sem percentual usa o highlight do primeiro cupom', () => {
      expect(derivarMelhorBeneficio(['R$ 50', 'Grátis'])).toEqual({
        melhorBeneficio: 'R$ 50',
        textoDesconto: 'R$ 50',
      });
    });

    it('sem cupons devolve nulos', () => {
      expect(derivarMelhorBeneficio([])).toEqual({
        melhorBeneficio: null,
        textoDesconto: null,
      });
    });
  });

  it('mascararCpfPainel mantém só o miolo', () => {
    expect(mascararCpfPainel('123.456.789-09')).toBe('***.456.789-**');
    expect(mascararCpfPainel('123')).toBe('***.***.***-**');
  });

  it('normalizarCodigoCupom remove espaços e usa caixa alta', () => {
    expect(normalizarCodigoCupom(' prime 15 rev ')).toBe('PRIME15REV');
  });
});
