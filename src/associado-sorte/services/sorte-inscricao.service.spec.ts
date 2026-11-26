/* eslint-disable @typescript-eslint/no-explicit-any -- spec com dublês em memória: registros soltos, conferidos pelas asserções */
import { Test } from '@nestjs/testing';
import { SorteInscricoesRepository } from 'src/associado-sorte/repositories/sorte-inscricoes.repository';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteInscricaoService } from 'src/associado-sorte/services/sorte-inscricao.service';
import { configDeTeste } from 'src/associado-sorte/testing/sorte-fixtures';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';

describe('SorteInscricaoService', () => {
  let service: SorteInscricaoService;
  /** "Tabela" SorteInscricao em memória (PK userId). */
  let tabela: Map<number, any>;

  const config = configDeTeste();
  const sga = { executeRequestWithAuth: jest.fn() };
  const beneficios = { getBeneficiosVeiculoAtual: jest.fn() };
  const repository = {
    buscar: jest.fn((userId: number) =>
      Promise.resolve(tabela.get(userId) ?? null),
    ),
    buscarUsuario: jest.fn((id: number) =>
      Promise.resolve({ id, cpf: '123.456.789-09', baseOrigin: 'MAIS_PRIME' }),
    ),
    salvarDoSga: jest.fn((userId: number, data: any) => {
      const atual = tabela.get(userId);
      if (atual?.fonte === 'MANUAL') return Promise.resolve();
      tabela.set(userId, { userId, fonte: 'SGA', ...data });
      return Promise.resolve();
    }),
  };

  const ATIVO = { situacao: 'ATIVO' };
  const produto = (extra: object = {}) => ({
    codigo_produto: '3677',
    descricao: 'ASSOCIADO DA SORTE',
    situacao: 'ATIVO',
    ...extra,
  });
  const veiculos = (lista: object[]) =>
    sga.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: { veiculos: lista },
    });
  const produtosPorVeiculo = (mapa: Record<string, object[]>) =>
    beneficios.getBeneficiosVeiculoAtual.mockImplementation(
      (_b: string, c: string) => Promise.resolve({ produtos: mapa[c] ?? [] }),
    );

  const situacao = (userId = 7, agora = new Date()) =>
    service.situacao(userId, 'MAIS_PRIME', config, { agora });

  beforeEach(async () => {
    jest.clearAllMocks();
    tabela = new Map();
    const module = await Test.createTestingModule({
      providers: [
        SorteInscricaoService,
        { provide: SorteInscricoesRepository, useValue: repository },
        { provide: SorteConfigService, useValue: {} },
        { provide: SgaAuthService, useValue: sga },
        { provide: BeneficiosVeiculoService, useValue: beneficios },
      ],
    }).compile();
    service = module.get(SorteInscricaoService);
  });

  it('inscrito com o produto 3677 / "ASSOCIADO DA SORTE" ATIVO (descrição sem acento e com espaços)', async () => {
    veiculos([{ codigo_veiculo: '111', ...ATIVO }]);
    produtosPorVeiculo({
      '111': [produto({ descricao: '  associado  da sórte ' })],
    });
    const r = await situacao();
    expect(r).toMatchObject({ inscrito: true, motivo: null, fonte: 'SGA' });
    expect(sga.executeRequestWithAuth).toHaveBeenCalledWith(
      'MAIS_PRIME',
      expect.objectContaining({
        url: expect.stringContaining('/associado/buscar/12345678909'),
      }),
    );
    expect(tabela.get(7)).toMatchObject({
      inscrito: true,
      codigoVeiculo: '111',
    });
  });

  it.each([
    ['código diferente', produto({ codigo_produto: '3678' })],
    ['descrição diferente', produto({ descricao: 'ASSOCIADO PREMIUM' })],
    ['produto INATIVO', produto({ situacao: 'INATIVO' })],
  ])('%s → NAO_INSCRITO (código e descrição precisam bater)', async (_n, p) => {
    veiculos([{ codigo_veiculo: '111', ...ATIVO }]);
    produtosPorVeiculo({ '111': [p] });
    await expect(situacao()).resolves.toMatchObject({
      inscrito: false,
      motivo: 'NAO_INSCRITO',
    });
  });

  it('veículo sem acesso ao app não conta', async () => {
    veiculos([{ codigo_veiculo: '111', situacao: 'INATIVO' }]);
    produtosPorVeiculo({ '111': [produto()] });
    await expect(situacao()).resolves.toMatchObject({ inscrito: false });
    expect(beneficios.getBeneficiosVeiculoAtual).not.toHaveBeenCalled();
  });

  it('dois veículos inscritos = um participante (para no primeiro)', async () => {
    veiculos([
      { codigo_veiculo: '111', ...ATIVO },
      { codigo_veiculo: '222', ...ATIVO },
    ]);
    produtosPorVeiculo({ '111': [produto()], '222': [produto()] });
    await situacao();
    await situacao(7, new Date(Date.now() + 7 * 3_600_000)); // cache vencido
    expect(beneficios.getBeneficiosVeiculoAtual).toHaveBeenCalledTimes(2);
    expect(beneficios.getBeneficiosVeiculoAtual).toHaveBeenNthCalledWith(
      1,
      'MAIS_PRIME',
      '111',
    );
    expect(tabela.size).toBe(1);
    expect(repository.salvarDoSga).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ inscrito: true }),
    );
  });

  it('segundo veículo inscrito também vale', async () => {
    veiculos([
      { codigo_veiculo: '111', ...ATIVO },
      { codigo_veiculo: '222', ...ATIVO },
    ]);
    produtosPorVeiculo({ '111': [], '222': [produto()] });
    await expect(situacao()).resolves.toMatchObject({ inscrito: true });
    expect(tabela.get(7).codigoVeiculo).toBe('222');
  });

  it('usa o cache dentro da validade (sem chamar o SGA)', async () => {
    tabela.set(7, {
      userId: 7,
      inscrito: true,
      fonte: 'SGA',
      verificadoEm: new Date(Date.now() - 3_600_000),
    });
    await expect(situacao()).resolves.toMatchObject({ inscrito: true });
    expect(sga.executeRequestWithAuth).not.toHaveBeenCalled();
  });

  it('SGA fora do ar: usa o último valor do cache', async () => {
    tabela.set(7, {
      userId: 7,
      inscrito: true,
      fonte: 'SGA',
      verificadoEm: new Date(Date.now() - 10 * 3_600_000),
    });
    sga.executeRequestWithAuth.mockResolvedValue({ status: 503, data: {} });
    await expect(situacao()).resolves.toMatchObject({
      inscrito: true,
      motivo: null,
    });
  });

  it('SGA fora do ar e nunca verificado: VERIFICACAO_INDISPONIVEL', async () => {
    sga.executeRequestWithAuth.mockRejectedValue(new Error('timeout'));
    await expect(situacao()).resolves.toEqual({
      inscrito: false,
      motivo: 'VERIFICACAO_INDISPONIVEL',
      fonte: null,
      verificadoEm: null,
    });
    expect(tabela.size).toBe(0);
  });

  it('falha nos produtos de um veículo sem nenhum inscrito conta como indisponível', async () => {
    veiculos([{ codigo_veiculo: '111', ...ATIVO }]);
    beneficios.getBeneficiosVeiculoAtual.mockRejectedValue(new Error('500'));
    await expect(situacao()).resolves.toMatchObject({
      motivo: 'VERIFICACAO_INDISPONIVEL',
    });
  });

  it('CPF desconhecido no SGA (406): não inscrito', async () => {
    sga.executeRequestWithAuth.mockResolvedValue({ status: 406, data: {} });
    await expect(situacao()).resolves.toMatchObject({
      inscrito: false,
      motivo: 'NAO_INSCRITO',
    });
  });

  it('marcação MANUAL prevalece e não chama o SGA', async () => {
    tabela.set(7, {
      userId: 7,
      inscrito: true,
      fonte: 'MANUAL',
      verificadoEm: new Date(0),
    });
    await expect(situacao()).resolves.toMatchObject({
      inscrito: true,
      fonte: 'MANUAL',
    });
    expect(sga.executeRequestWithAuth).not.toHaveBeenCalled();
  });
});
