import {
  coordenadasDaPosicao,
  escolherPosicao,
  timestampDaPosicao,
} from 'src/rastreamento/domain/posicao';

describe('domínio — posição', () => {
  describe('timestampDaPosicao', () => {
    it('lê ISO com espaço ou com T no fuso do processo', () => {
      expect(timestampDaPosicao('2026-08-31 10:00:00')).toBe(
        new Date(2026, 7, 31, 10, 0, 0).getTime(),
      );
      expect(timestampDaPosicao('2026-08-31T10:00:00')).toBe(
        new Date(2026, 7, 31, 10, 0, 0).getTime(),
      );
    });

    it('lê o formato brasileiro, com e sem segundos', () => {
      expect(timestampDaPosicao('31/08/2026 12:30:15')).toBe(
        new Date(2026, 7, 31, 12, 30, 15).getTime(),
      );
      expect(timestampDaPosicao(' 31/08/2026 12:30 ')).toBe(
        new Date(2026, 7, 31, 12, 30, 0).getTime(),
      );
    });

    it.each([undefined, null, '', '   ', 'ontem', 123, {}])(
      'data ausente ou irreconhecível (%p) → null',
      (valor) => {
        expect(timestampDaPosicao(valor)).toBeNull();
      },
    );
  });

  describe('escolherPosicao', () => {
    const HORA = 60 * 60 * 1000;
    const c = (origem: string, timestamp: number) => ({ origem, timestamp });

    it('lista vazia → null', () => {
      expect(escolherPosicao([])).toBeNull();
    });

    it('vence a mais recente', () => {
      expect(
        escolherPosicao([c('logica', 10), c('m7', 30), c('outro', 20)]),
      ).toEqual(c('m7', 30));
    });

    it('no empate vence quem vem antes na lista', () => {
      expect(escolherPosicao([c('logica', 10), c('m7', 10)])?.origem).toBe(
        'logica',
      );
    });

    it('M7 vence a Softruck dentro de 1 h, mesmo mais antiga', () => {
      expect(escolherPosicao([c('m7', 0), c('softruck', HORA)])?.origem).toBe(
        'm7',
      );
    });

    it('Softruck vence a M7 quando está mais de 1 h à frente', () => {
      expect(
        escolherPosicao([c('m7', 0), c('softruck', HORA + 1)])?.origem,
      ).toBe('softruck');
    });

    it('a preferência só vale contra o provedor indicado', () => {
      expect(escolherPosicao([c('m7', 0), c('logica', 1000)])?.origem).toBe(
        'logica',
      );
    });

    it('aceita outra tabela de preferências', () => {
      expect(
        escolherPosicao(
          [c('novo', 0), c('m7', 500)],
          [{ preferido: 'novo', sobre: 'm7', toleranciaMs: 1000 }],
        )?.origem,
      ).toBe('novo');
    });
  });

  describe('coordenadasDaPosicao', () => {
    it('aceita número e texto (com ponto ou vírgula)', () => {
      expect(coordenadasDaPosicao(-22.9, '-43,2')).toEqual({
        latitude: -22.9,
        longitude: -43.2,
      });
    });

    it('valor ausente ou não numérico → null', () => {
      expect(coordenadasDaPosicao(undefined, -43.2)).toBeNull();
      expect(coordenadasDaPosicao('x', '-43.2')).toBeNull();
    });
  });
});
