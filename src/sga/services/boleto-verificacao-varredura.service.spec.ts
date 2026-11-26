import { registroDeMetricas } from 'src/infra/observability/metricas';
import {
  BoletoVerificacaoConfig,
  INTERVALO_BASE_MS,
} from 'src/sga/config/boleto-verificacao.config';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { BoletoVerificacaoVarreduraService } from 'src/sga/services/boleto-verificacao-varredura.service';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';

const MIN = 60_000;
const DIA = 86_400_000;

const expirados = async (): Promise<number> => {
  const metrica = await registroDeMetricas
    .getSingleMetric('boleto_reativacao_total')!
    .get();
  return metrica.values
    .filter((v) => v.labels.evento === 'expirado')
    .reduce((soma, v) => soma + v.value, 0);
};

/**
 * Varredura da verificação de pagamento: cadência por idade do boleto,
 * encerramentos e o que acontece quando uma linha falha.
 */
describe('BoletoVerificacaoVarreduraService', () => {
  const agora = Date.UTC(2026, 10, 26, 12, 0, 0);
  const config: BoletoVerificacaoConfig = {
    intervaloBaseMs: INTERVALO_BASE_MS,
    maxDias: 30,
    intervaloApos24hMin: 10,
    intervaloApos7dMin: 60,
    espacamentoMs: 0,
  };

  let pagamentos: {
    reservarLote: jest.Mock;
    reagendar: jest.Mock;
    encerrar: jest.Mock;
    baseDoDonoDoVeiculo: jest.Mock;
  };
  let verificacao: { verificar: jest.Mock };
  let servico: BoletoVerificacaoVarreduraService;

  const linha = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    userVehicleId: 7,
    nossoNumero: '123',
    pago: false,
    pagoEm: null,
    boletoCriadoEm: new Date(agora - 60 * MIN),
    updatedAt: new Date(agora),
    reativadoEm: null,
    pagoNotificadoEm: null,
    proximaConsultaEm: new Date(agora - MIN),
    verificacaoEncerradaEm: null,
    baseOrigin: 'MAIS_PRIME',
    codigoVeiculo: '55',
    codigoAssociado: 9,
    nomeAssociado: 'Fulano de Tal',
    telefoneAssociado: '31999999999',
    reservadaAte: new Date(agora + 10 * MIN),
    ...extra,
  });

  /** A varredura recebe este lote e, na reserva seguinte, nada. */
  const comLote = (...linhas: Array<Record<string, unknown>>) =>
    pagamentos.reservarLote.mockResolvedValueOnce(linhas).mockResolvedValue([]);

  beforeEach(() => {
    jest.useFakeTimers({ now: agora });
    pagamentos = {
      reservarLote: jest.fn().mockResolvedValue([]),
      reagendar: jest.fn().mockResolvedValue(true),
      encerrar: jest.fn().mockResolvedValue(true),
      baseDoDonoDoVeiculo: jest.fn().mockResolvedValue(null),
    };
    verificacao = { verificar: jest.fn().mockResolvedValue('EM_ABERTO') };
    servico = new BoletoVerificacaoVarreduraService(
      pagamentos as unknown as PagamentoBoletoRepository,
      verificacao as unknown as VerificarPagamentoBoletoService,
    );
    Object.assign(servico, { config });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sem boleto vencido: não consulta nada', async () => {
    const resumo = await servico.executar();

    expect(resumo.reservados).toBe(0);
    expect(verificacao.verificar).not.toHaveBeenCalled();
  });

  it('reserva o lote empurrando a próxima consulta para a frente (10 min)', async () => {
    await servico.executar();

    expect(pagamentos.reservarLote).toHaveBeenCalledWith({
      agora: new Date(agora),
      limite: 10,
      reservaMs: 10 * MIN,
    });
  });

  it('verifica o boleto com os dados gravados na linha (o que o job repetível carregava)', async () => {
    comLote(linha());

    await servico.executar();

    expect(verificacao.verificar).toHaveBeenCalledWith(
      {
        userVehicleId: 7,
        nossoNumero: '123',
        codigoVeiculo: '55',
        codigoAssociado: 9,
        nomeAssociado: 'Fulano de Tal',
        telefoneAssociado: '31999999999',
      },
      'MAIS_PRIME',
      expect.objectContaining({ id: 1 }),
    );
  });

  describe('cadência por idade do boleto', () => {
    it.each([
      ['menos de 24 h', 60 * MIN, 2 * MIN],
      ['mais de 24 h', 2 * DIA, 10 * MIN],
      ['mais de 7 dias', 10 * DIA, 60 * MIN],
    ])(
      'boleto com %s em aberto: próxima consulta no intervalo da faixa',
      async (_caso, idade, intervalo) => {
        comLote(linha({ boletoCriadoEm: new Date(agora - idade) }));

        const resumo = await servico.executar();

        expect(pagamentos.reagendar).toHaveBeenCalledWith(
          1,
          new Date(agora + intervalo),
        );
        expect(pagamentos.encerrar).not.toHaveBeenCalled();
        expect(resumo.emAberto).toBe(1);
      },
    );

    it('SGA sem resposta: também reagenda pela idade (não insiste em rajada)', async () => {
      verificacao.verificar.mockResolvedValue('SEM_RESPOSTA');
      comLote(linha({ boletoCriadoEm: new Date(agora - 2 * DIA) }));

      await servico.executar();

      expect(pagamentos.reagendar).toHaveBeenCalledWith(
        1,
        new Date(agora + 10 * MIN),
      );
    });
  });

  describe('encerramentos', () => {
    it.each(['PAGO_E_REATIVADO', 'CANCELADO'])(
      '%s: a verificação já encerrou a linha; a varredura não reagenda',
      async (desfecho) => {
        verificacao.verificar.mockResolvedValue(desfecho);
        comLote(linha());

        const resumo = await servico.executar();

        expect(pagamentos.reagendar).not.toHaveBeenCalled();
        expect(resumo.encerrados).toBe(1);
      },
    );

    it('idade máxima sem pagamento: encerra sem consultar o SGA, com aviso e métrica `expirado`', async () => {
      const aviso = jest
        .spyOn(servico['logger'], 'warn')
        .mockImplementation(() => undefined);
      const antes = await expirados();
      comLote(linha({ boletoCriadoEm: new Date(agora - 31 * DIA) }));

      const resumo = await servico.executar();

      expect(verificacao.verificar).not.toHaveBeenCalled();
      expect(pagamentos.encerrar).toHaveBeenCalledWith('123', new Date(agora));
      expect(resumo.expirados).toBe(1);
      expect(await expirados()).toBe(antes + 1);
      expect(aviso).toHaveBeenCalledWith(
        expect.stringContaining('além da idade máxima'),
      );
      expect(aviso.mock.calls[0][0]).toContain('sem pagamento');
    });

    it('idade máxima com boleto PAGO e nunca reativado: o aviso diz isso', async () => {
      const aviso = jest
        .spyOn(servico['logger'], 'warn')
        .mockImplementation(() => undefined);
      comLote(
        linha({ boletoCriadoEm: new Date(agora - 31 * DIA), pago: true }),
      );

      await servico.executar();

      expect(aviso.mock.calls[0][0]).toContain(
        'PAGO, mas a reativação no SGA nunca foi aceita',
      );
    });
  });

  describe('falha numa linha', () => {
    it('reativação recusada (ou qualquer erro): nada encerra, a linha volta na próxima rodada e a rodada falha', async () => {
      verificacao.verificar
        .mockRejectedValueOnce(
          new Error('Boleto 123 pago, mas o SGA respondeu HTTP 403'),
        )
        .mockResolvedValueOnce('EM_ABERTO');
      comLote(linha(), linha({ id: 2, nossoNumero: '456' }));

      await expect(servico.executar()).rejects.toThrow(
        /1 de 2 não concluíram — boleto 123: Boleto 123 pago, mas o SGA respondeu HTTP 403/,
      );

      expect(pagamentos.encerrar).not.toHaveBeenCalled();
      // As duas linhas voltam à varredura; a segunda foi processada mesmo
      // com a primeira falhando.
      expect(pagamentos.reagendar).toHaveBeenCalledWith(
        1,
        new Date(agora + 2 * MIN),
      );
      expect(pagamentos.reagendar).toHaveBeenCalledWith(
        2,
        new Date(agora + 2 * MIN),
      );
      expect(verificacao.verificar).toHaveBeenCalledTimes(2);
    });
  });

  describe('base da linha', () => {
    it('linha sem base gravada: usa a do dono do veículo', async () => {
      pagamentos.baseDoDonoDoVeiculo.mockResolvedValue('MAIS_PRIME_RS');
      comLote(linha({ baseOrigin: null }));

      await servico.executar();

      expect(pagamentos.baseDoDonoDoVeiculo).toHaveBeenCalledWith(7);
      expect(verificacao.verificar.mock.calls[0][1]).toBe('MAIS_PRIME_RS');
    });

    it('sem base válida: a linha falha — nunca consulta o SGA com a base padrão', async () => {
      comLote(linha({ baseOrigin: 'OUTRA_EMPRESA' }));

      await expect(servico.executar()).rejects.toThrow(/não concluíram/);
      expect(verificacao.verificar).not.toHaveBeenCalled();
    });
  });

  it('reserva perto de vencer: a linha fica para depois em vez de ser processada fora da reserva', async () => {
    comLote(linha({ reservadaAte: new Date(agora + 2 * MIN) }));

    const resumo = await servico.executar();

    expect(verificacao.verificar).not.toHaveBeenCalled();
    expect(resumo.adiados).toBe(1);
  });

  it('lote cheio: reserva o seguinte na mesma rodada', async () => {
    const dez = Array.from({ length: 10 }, (_, i) =>
      linha({ id: i + 1, nossoNumero: String(100 + i) }),
    );
    pagamentos.reservarLote
      .mockResolvedValueOnce(dez)
      .mockResolvedValueOnce([linha({ id: 11, nossoNumero: '999' })])
      .mockResolvedValue([]);

    const resumo = await servico.executar();

    expect(resumo.reservados).toBe(11);
    expect(verificacao.verificar).toHaveBeenCalledTimes(11);
    expect(pagamentos.reservarLote).toHaveBeenCalledTimes(2);
  });
});
