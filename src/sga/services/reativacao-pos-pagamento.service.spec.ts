import { registroDeMetricas } from 'src/infra/observability/metricas';
import { IntegrationError, ehErroTransitorio } from 'src/shared/erros/erros';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { ReativacaoPosPagamentoService } from 'src/sga/services/reativacao-pos-pagamento.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';

const contador = async (evento: string): Promise<number> => {
  const metrica = await registroDeMetricas
    .getSingleMetric('boleto_reativacao_total')!
    .get();
  return metrica.values
    .filter((v) => v.labels.evento === evento)
    .reduce((soma, v) => soma + v.value, 0);
};

/** Reativação do veículo e do associado no SGA depois do boleto pago. */
describe('ReativacaoPosPagamentoService', () => {
  let client: {
    alterarSituacaoDoVeiculo: jest.Mock;
    alterarSituacaoDoAssociado: jest.Mock;
    invalidarLeituras: jest.Mock;
  };
  let pagamentos: { donoDoVeiculo: jest.Mock; marcarReativado: jest.Mock };
  let servico: ReativacaoPosPagamentoService;

  const boleto = {
    userVehicleId: 7,
    nossoNumero: '123',
    codigoVeiculo: '55',
    codigoAssociado: 9,
    nomeAssociado: 'Fulano de Tal',
    telefoneAssociado: '31999999999',
  };
  const ok = { status: 200, data: {} };

  beforeEach(() => {
    client = {
      alterarSituacaoDoVeiculo: jest.fn().mockResolvedValue(ok),
      alterarSituacaoDoAssociado: jest.fn().mockResolvedValue(ok),
      invalidarLeituras: jest.fn().mockResolvedValue(undefined),
    };
    pagamentos = {
      donoDoVeiculo: jest
        .fn()
        .mockResolvedValue({ cpf: '529.982.247-25', baseOrigin: 'MAIS_PRIME' }),
      marcarReativado: jest.fn().mockResolvedValue(true),
    };
    servico = new ReativacaoPosPagamentoService(
      client as unknown as SgaBoletoClient,
      pagamentos as unknown as PagamentoBoletoRepository,
    );
  });

  it('reativa veículo e associado com as situações da regra da base e marca `reativadoEm`', async () => {
    const antes = await contador('reativado');

    await servico.executar(boleto, 'MAIS_PRIME', null);

    expect(client.alterarSituacaoDoVeiculo).toHaveBeenCalledWith(
      'MAIS_PRIME',
      1,
      '55',
    );
    expect(pagamentos.marcarReativado).toHaveBeenCalledWith(
      '123',
      expect.any(Date),
    );
    expect(client.alterarSituacaoDoAssociado).toHaveBeenCalledWith(
      'MAIS_PRIME',
      1,
      9,
    );
    expect(await contador('reativado')).toBe(antes + 1);
  });

  it('invalida o cache do associado e dos boletos ao detectar o pagamento e de novo depois de reativar', async () => {
    const ordem: string[] = [];
    client.invalidarLeituras.mockImplementation(() => {
      ordem.push('invalidar');
      return Promise.resolve();
    });
    client.alterarSituacaoDoVeiculo.mockImplementation(() => {
      ordem.push('veiculo');
      return Promise.resolve(ok);
    });
    client.alterarSituacaoDoAssociado.mockImplementation(() => {
      ordem.push('associado');
      return Promise.resolve(ok);
    });

    await servico.executar(boleto, 'MAIS_PRIME', null);

    expect(ordem).toEqual(['invalidar', 'veiculo', 'associado', 'invalidar']);
    expect(client.invalidarLeituras).toHaveBeenCalledWith('MAIS_PRIME', {
      cpf: '529.982.247-25',
      codigoVeiculo: '55',
    });
  });

  it('SGA recusa a reativação do VEÍCULO: lança, não marca nada e não chega ao associado', async () => {
    client.alterarSituacaoDoVeiculo.mockResolvedValue({
      status: 403,
      data: { mensagem: 'bloqueado' },
    });
    const antes = await contador('falha_reativacao');

    await expect(servico.executar(boleto, 'MAIS_PRIME', null)).rejects.toThrow(
      /HTTP 403 ao reativar o veículo 55/,
    );

    expect(pagamentos.marcarReativado).not.toHaveBeenCalled();
    expect(client.alterarSituacaoDoAssociado).not.toHaveBeenCalled();
    expect(await contador('falha_reativacao')).toBe(antes + 1);
  });

  it('SGA recusa a reativação do ASSOCIADO: lança (antes só avisava e a verificação encerrava)', async () => {
    client.alterarSituacaoDoAssociado.mockResolvedValue({
      status: 500,
      data: 'erro interno',
    });
    const antes = await contador('falha_reativacao');

    const erro: unknown = await servico
      .executar(boleto, 'MAIS_PRIME', null)
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(erro).toBeInstanceOf(IntegrationError);
    expect((erro as Error).message).toMatch(
      /HTTP 500 ao reativar o associado 9/,
    );
    // 5xx vale nova tentativa; o veículo já ficou marcado como reativado.
    expect(ehErroTransitorio(erro)).toBe(true);
    expect(pagamentos.marcarReativado).toHaveBeenCalledTimes(1);
    expect(await contador('falha_reativacao')).toBe(antes + 1);
  });

  it('nova rodada depois da recusa do associado: NÃO reativa o veículo de novo, só tenta o associado', async () => {
    await servico.executar(boleto, 'MAIS_PRIME', {
      reativadoEm: new Date('2026-11-26T12:00:00Z'),
    });

    expect(client.alterarSituacaoDoVeiculo).not.toHaveBeenCalled();
    expect(pagamentos.marcarReativado).not.toHaveBeenCalled();
    expect(client.alterarSituacaoDoAssociado).toHaveBeenCalledTimes(1);
  });

  it('falha ao gravar o marcador do veículo propaga (não segue como se estivesse gravado)', async () => {
    pagamentos.marcarReativado.mockRejectedValue(new Error('banco fora'));

    await expect(servico.executar(boleto, 'MAIS_PRIME', null)).rejects.toThrow(
      'banco fora',
    );
    expect(client.alterarSituacaoDoAssociado).not.toHaveBeenCalled();
  });

  it('sem codigo_associado (boleto antigo): reativa só o veículo', async () => {
    await servico.executar(
      { ...boleto, codigoAssociado: null },
      'MAIS_PRIME',
      null,
    );

    expect(client.alterarSituacaoDoVeiculo).toHaveBeenCalledTimes(1);
    expect(client.alterarSituacaoDoAssociado).not.toHaveBeenCalled();
  });
});
