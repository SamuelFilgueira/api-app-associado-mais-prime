import {
  ATRASO_DA_PRIMEIRA_CHECAGEM_MS,
  TETO_DE_CHECAGENS,
  VALIDADE_DA_SESSAO_PENDENTE_MS,
  atrasoAteAProximaChecagem,
  chaveDePendencia,
  corteDeSessaoPendente,
  decidirChecagem,
  jobIdDaChecagem,
  mensagemDeEconomia,
  numeroDaChecagem,
} from 'src/fuel-session/domain/verificacao-de-economia';

describe('verificação de economia (regra pura)', () => {
  describe('tempos das checagens — os mesmos de quando "sem variação" era retry', () => {
    it('primeira checagem 5 minutos depois do cartão', () => {
      expect(ATRASO_DA_PRIMEIRA_CHECAGEM_MS).toBe(5 * 60 * 1000);
    });

    it('intervalos seguintes: 60 s e 120 s (backoff exponencial de 60 s), 3 checagens no total', () => {
      expect(TETO_DE_CHECAGENS).toBe(3);
      expect(atrasoAteAProximaChecagem(1)).toBe(60_000);
      expect(atrasoAteAProximaChecagem(2)).toBe(120_000);
    });

    it('linha do tempo completa: 5, 6 e 8 minutos depois do toque', () => {
      const instantes = [ATRASO_DA_PRIMEIRA_CHECAGEM_MS];
      for (let checagem = 1; checagem < TETO_DE_CHECAGENS; checagem++) {
        instantes.push(
          instantes[instantes.length - 1] + atrasoAteAProximaChecagem(checagem),
        );
      }
      expect(instantes.map((ms) => ms / 60_000)).toEqual([5, 6, 8]);
    });
  });

  describe('numeroDaChecagem', () => {
    it('job novo: vale o contador do payload, não as tentativas do job', () => {
      expect(numeroDaChecagem({ checagem: 2 }, 0)).toBe(2);
      // Retry por erro de verdade não avança a checagem.
      expect(numeroDaChecagem({ checagem: 2 }, 2)).toBe(2);
    });

    it('job antigo (sem contador): as tentativas já gastas são as checagens já feitas', () => {
      expect(numeroDaChecagem({}, 0)).toBe(1);
      expect(numeroDaChecagem({}, 1)).toBe(2);
      expect(numeroDaChecagem({}, 2)).toBe(3);
    });

    it.each([[0], [-1], [1.5], [NaN], ['2'], [null]])(
      'contador inválido (%p) é tratado como ausente',
      (checagem) => {
        expect(numeroDaChecagem({ checagem: checagem as never }, 1)).toBe(2);
      },
    );
  });

  describe('decidirChecagem', () => {
    it('total subiu: abasteceu, com a diferença sobre o valor de partida', () => {
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 112.5, checagem: 1 }),
      ).toEqual({ tipo: 'ABASTECEU', diferenca: 12.5, novoTotal: 112.5 });
    });

    it('abastecimento detectado na última checagem ainda vale', () => {
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 101, checagem: 3 }),
      ).toEqual({ tipo: 'ABASTECEU', diferenca: 1, novoTotal: 101 });
    });

    it('sem variação antes do teto: reagenda a próxima checagem', () => {
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 100, checagem: 1 }),
      ).toEqual({ tipo: 'REAGENDAR', proximaChecagem: 2, atrasoMs: 60_000 });
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 100, checagem: 2 }),
      ).toEqual({ tipo: 'REAGENDAR', proximaChecagem: 3, atrasoMs: 120_000 });
    });

    it('total menor que o de partida também é "sem variação"', () => {
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 90, checagem: 1 }).tipo,
      ).toBe('REAGENDAR');
    });

    it('sem variação no teto (ou além dele): expira', () => {
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 100, checagem: 3 }),
      ).toEqual({ tipo: 'EXPIRAR' });
      expect(
        decidirChecagem({ valorAntes: 100, valorAtual: 100, checagem: 7 }),
      ).toEqual({ tipo: 'EXPIRAR' });
    });
  });

  it('jobId é determinístico por sessão e checagem, sem ":"', () => {
    const id = jobIdDaChecagem('3f2a-uuid', 2);

    expect(id).toBe('fuel-3f2a-uuid-c2');
    expect(id).not.toContain(':');
    expect(jobIdDaChecagem('3f2a-uuid', 2)).toBe(id);
    expect(jobIdDaChecagem('3f2a-uuid', 3)).not.toBe(id);
  });

  it('a chave de pendência é o id do usuário', () => {
    expect(chaveDePendencia(42)).toBe('42');
  });

  it('sessão pendente vence 30 minutos depois de criada', () => {
    const agora = new Date('2026-11-25T12:00:00.000Z');

    expect(VALIDADE_DA_SESSAO_PENDENTE_MS).toBe(30 * 60_000);
    expect(corteDeSessaoPendente(agora)).toEqual(
      new Date('2026-11-25T11:30:00.000Z'),
    );
  });

  it('texto do push de economia', () => {
    expect(mensagemDeEconomia(12.5)).toEqual({
      titulo: 'Abastecimento detectado! 🎉',
      corpo: 'Parabéns! Você economizou R$ 12,50 neste abastecimento.',
    });
  });
});
