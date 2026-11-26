import {
  MAX_TENTATIVAS_DA_ENTREGA,
  atrasoDosRecibos,
  chaveDeConteudo,
  classificarResultados,
  contagemDoDisparo,
  desfechoDoDisparo,
  entregaAberta,
  jobIdDoLote,
  jobIdDosRecibos,
  mesmosDestinatarios,
  paginasComPendencia,
  resumirErro,
} from 'src/notifications/domain/push-disparo';

describe('push em massa — regras puras', () => {
  const entrega = (id: number) => ({
    id,
    userId: id * 10,
    expoPushToken: `ExponentPushToken[${id}]`,
  });

  describe('classificarResultados', () => {
    it('casa cada entrega com o resultado da mesma posição', () => {
      const lote = classificarResultados(
        [entrega(1), entrega(2), entrega(3), entrega(4)],
        [
          { status: 'ok', ticketId: 't-1' },
          {
            status: 'recusado',
            mensagem: 'não registrado',
            detalhe: 'DeviceNotRegistered',
          },
          { status: 'falha_transporte', mensagem: 'timeout' },
          { status: 'recusado', mensagem: 'grande demais' },
        ],
      );

      expect(lote.aceitas).toEqual([{ ...entrega(1), ticketId: 't-1' }]);
      expect(lote.recusadas).toEqual([
        {
          ...entrega(2),
          erro: 'DeviceNotRegistered: não registrado',
          tokenMorto: true,
        },
        { ...entrega(4), erro: 'grande demais', tokenMorto: false },
      ]);
      expect(lote.falhas).toEqual([{ ...entrega(3), erro: 'timeout' }]);
    });

    it('entrega sem resultado conta como falha de transporte (volta a ser tentada)', () => {
      const lote = classificarResultados(
        [entrega(1), entrega(2)],
        [{ status: 'ok' }],
      );
      expect(lote.aceitas).toEqual([{ ...entrega(1), ticketId: null }]);
      expect(lote.falhas).toEqual([
        { ...entrega(2), erro: 'Sem resultado do provedor' },
      ]);
    });
  });

  describe('entregaAberta', () => {
    it('pendente sempre; falha só dentro do limite de tentativas', () => {
      expect(entregaAberta({ estado: 'PENDENTE', tentativas: 0 })).toBe(true);
      expect(entregaAberta({ estado: 'FALHA', tentativas: 1 })).toBe(true);
      expect(
        entregaAberta({
          estado: 'FALHA',
          tentativas: MAX_TENTATIVAS_DA_ENTREGA,
        }),
      ).toBe(false);
      for (const estado of ['ENVIADA', 'ENTREGUE', 'RECUSADA']) {
        expect(entregaAberta({ estado, tentativas: 0 })).toBe(false);
      }
    });
  });

  describe('paginasComPendencia', () => {
    const entregas = (total: number, abertas: (id: number) => boolean) =>
      Array.from({ length: total }, (_, i) => ({
        id: i + 1,
        aberta: abertas(i + 1),
      }));

    it('250 entregas abertas: páginas de 100, 100 e 50', () => {
      expect(paginasComPendencia(entregas(250, () => true))).toEqual([
        { deId: 1, ateId: 100 },
        { deId: 101, ateId: 200 },
        { deId: 201, ateId: 250 },
      ]);
    });

    it('as fronteiras não mudam quando parte já foi enviada: só some a página sem pendência', () => {
      // Só a entrega 150 segue aberta: a página dela continua sendo 101–200.
      expect(paginasComPendencia(entregas(250, (id) => id === 150))).toEqual([
        { deId: 101, ateId: 200 },
      ]);
      expect(paginasComPendencia(entregas(250, () => false))).toEqual([]);
    });

    it('ids com buracos (entregas de outros disparos no meio) seguem a ordem recebida', () => {
      const comBuracos = [3, 7, 8, 20, 21].map((id) => ({ id, aberta: true }));
      expect(paginasComPendencia(comBuracos, 2)).toEqual([
        { deId: 3, ateId: 7 },
        { deId: 8, ateId: 20 },
        { deId: 21, ateId: 21 },
      ]);
    });
  });

  describe('contagem e desfecho', () => {
    it('entregue conta como enviada; pendente que sobrou conta como falha', () => {
      expect(
        contagemDoDisparo({
          ENVIADA: 5,
          ENTREGUE: 3,
          RECUSADA: 2,
          FALHA: 1,
          PENDENTE: 4,
        }),
      ).toEqual({ total: 15, enviadas: 8, recusadas: 2, falhas: 5 });
      expect(contagemDoDisparo({})).toEqual({
        total: 0,
        enviadas: 0,
        recusadas: 0,
        falhas: 0,
      });
    });

    it('algum push aceito: concluído, mesmo com recusas', () => {
      expect(
        desfechoDoDisparo({ total: 10, enviadas: 1, recusadas: 6, falhas: 3 }),
      ).toEqual({ estado: 'CONCLUIDO', statusDoLog: 'SENT', erro: null });
    });

    it('sem destinatários: sucesso com zero', () => {
      expect(
        desfechoDoDisparo({ total: 0, enviadas: 0, recusadas: 0, falhas: 0 }),
      ).toEqual({ estado: 'CONCLUIDO', statusDoLog: 'SENT', erro: null });
    });

    it('destinatários e nenhum push aceito: falhou, com o motivo', () => {
      expect(
        desfechoDoDisparo({ total: 5, enviadas: 0, recusadas: 2, falhas: 3 }),
      ).toEqual({
        estado: 'FALHOU',
        statusDoLog: 'FAILED',
        erro: 'Nenhum push aceito: 2 recusado(s) e 3 com falha de envio.',
      });
    });
  });

  describe('chaveDeConteudo', () => {
    const base = {
      tipo: 'MARKETING' as const,
      titulo: 'Oferta',
      corpo: 'Corpo',
      dados: { type: 'external_link', url: 'https://x' },
    };

    it('a ordem dos campos da carga e da lista não muda a chave', () => {
      expect(
        chaveDeConteudo({
          ...base,
          dados: { url: 'https://x', type: 'external_link' },
          userIds: [3, 1, 2],
        }),
      ).toBe(chaveDeConteudo({ ...base, userIds: [1, 2, 3] }));
    });

    it('texto, carga, tipo ou lista diferente: outra chave', () => {
      const chave = chaveDeConteudo(base);
      expect(chaveDeConteudo({ ...base, titulo: 'Oferta!' })).not.toBe(chave);
      expect(chaveDeConteudo({ ...base, corpo: 'Outro' })).not.toBe(chave);
      expect(chaveDeConteudo({ ...base, dados: { type: 'x' } })).not.toBe(
        chave,
      );
      expect(chaveDeConteudo({ ...base, tipo: 'SITUACAO_CADASTRO' })).not.toBe(
        chave,
      );
      expect(chaveDeConteudo({ ...base, userIds: [1] })).not.toBe(chave);
    });

    it('campo `undefined` na carga equivale a campo ausente (como no JSON gravado)', () => {
      expect(
        chaveDeConteudo({ ...base, dados: { ...base.dados, x: undefined } }),
      ).toBe(chaveDeConteudo(base));
    });
  });

  describe('mesmosDestinatarios', () => {
    it('disparo completo: precisa ser a mesma lista', () => {
      expect(mesmosDestinatarios([1, 2, 3], [3, 2, 1], false)).toBe(true);
      expect(mesmosDestinatarios([1, 2], [1, 2, 3], false)).toBe(false);
      expect(mesmosDestinatarios([1, 2, 4], [1, 2, 3], false)).toBe(false);
    });

    it('disparo ainda em criação: basta o que já foi gravado estar na lista', () => {
      expect(mesmosDestinatarios([1, 2], [1, 2, 3], true)).toBe(true);
      expect(mesmosDestinatarios([], [1, 2, 3], true)).toBe(true);
      expect(mesmosDestinatarios([9], [1, 2, 3], true)).toBe(false);
    });
  });

  it('ids de job: determinísticos, sem `:`, e a retomada tem id próprio', () => {
    expect(jobIdDoLote(7, 101)).toBe('push-7-101');
    expect(jobIdDoLote(7, 101, 1795000000)).toBe('push-7-101-r1795000000');
    expect(jobIdDosRecibos(7, 2)).toBe('push-recibos-7-2');
  });

  it('recibos: 15, 30 e 60 minutos', () => {
    expect([1, 2, 3].map(atrasoDosRecibos)).toEqual([
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
    ]);
  });

  it('resumirErro cabe na coluna e nunca fica vazio', () => {
    expect(resumirErro('x'.repeat(400))).toHaveLength(255);
    expect(resumirErro('   ')).toBe('Erro não informado');
    expect(resumirErro(undefined)).toBe('Erro não informado');
  });
});
