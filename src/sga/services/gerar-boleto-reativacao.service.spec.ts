import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { registroDeMetricas } from 'src/infra/observability/metricas';
import { FalhaAutenticacaoSga } from 'src/integrations/hinova/sga-auth.service';
import { IntegrationError } from 'src/shared/erros/erros';
import { BOLETO_LEASE_MS } from 'src/sga/domain/boleto-geracao';
import {
  BoletoCadastradoSemRegistroError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import { erroDaExcecaoSga } from 'src/sga/helpers/sga-instabilidade.helper';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { BoletoAdocaoService } from 'src/sga/services/boleto-adocao.service';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { BoletoDesfechoService } from 'src/sga/services/boleto-desfecho.service';
import { BoletoObtencaoService } from 'src/sga/services/boleto-obtencao.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { revistoriaEmMemoria } from 'src/sga/testing/revistoria.memoria';

const MIN = 60_000;

/** Promessa que o teste resolve quando quiser (segura o "SGA" no meio). */
function adiada<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

const ateQue = async (condicao: () => boolean) => {
  for (let i = 0; i < 200 && !condicao(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (!condicao()) throw new Error('condição não atingida');
};

const contador = async (evento: string): Promise<number> => {
  const metrica = await registroDeMetricas
    .getSingleMetric('boleto_reativacao_total')!
    .get();
  return metrica.values
    .filter((v) => v.labels.evento === evento)
    .reduce((soma, v) => soma + v.value, 0);
};

/**
 * A tentativa de gerar o boleto de reativação, com a revistoria num fake em
 * memória que respeita as escritas condicionais (lease e desfecho).
 */
describe('GerarBoletoReativacaoService', () => {
  let client: {
    listarBoletosParaAdocao: jest.Mock;
    buscarDadosAssociadoParaBoleto: jest.Mock;
    buscarProdutosDoVeiculo: jest.Mock;
    invalidarLeituras: jest.Mock;
  };
  let criacao: {
    criarBoletoReativacao: jest.Mock;
    registrarPagamentoBoleto: jest.Mock;
    concluirBoletoReativacao: jest.Mock;
    aplicarSituacaoAposBoleto: jest.Mock;
  };
  let mail: {
    sendRevistoriaAprovadaEmail: jest.Mock;
    sendRevistoriaAprovadaSemBoletoEmail: jest.Mock;
  };

  const boletoCriado = {
    nossoNumero: '555',
    linkBoleto: 'https://sga/boleto/555',
    suriEnviada: true,
  };

  function montar(inicial: Record<string, unknown> = {}) {
    const memoria = revistoriaEmMemoria(inicial);
    const revistorias = new BoletoReativacaoRepository(
      memoria.prisma as unknown as PrismaService,
    );
    const servico = new GerarBoletoReativacaoService(
      revistorias,
      new BoletoObtencaoService(
        new BoletoAdocaoService(
          client as unknown as SgaBoletoClient,
          criacao as unknown as BoletoCriacaoService,
        ),
        criacao as unknown as BoletoCriacaoService,
      ),
      new BoletoDesfechoService(revistorias, mail as unknown as MailService),
    );
    return { ...memoria, servico };
  }

  beforeEach(() => {
    client = {
      listarBoletosParaAdocao: jest.fn().mockResolvedValue([]),
      buscarDadosAssociadoParaBoleto: jest.fn().mockResolvedValue({
        codigoAssociado: 1,
        nome: 'Fulano',
        telefoneCelular: '31999999999',
      }),
      buscarProdutosDoVeiculo: jest
        .fn()
        .mockResolvedValue({ codigoVeiculo: '777' }),
      invalidarLeituras: jest.fn().mockResolvedValue(undefined),
    };
    criacao = {
      criarBoletoReativacao: jest.fn().mockResolvedValue(boletoCriado),
      registrarPagamentoBoleto: jest.fn().mockResolvedValue(undefined),
      concluirBoletoReativacao: jest
        .fn()
        .mockResolvedValue({ pollerAgendado: true, suriEnviada: true }),
      aplicarSituacaoAposBoleto: jest.fn().mockResolvedValue(true),
    };
    mail = {
      sendRevistoriaAprovadaEmail: jest.fn().mockResolvedValue(undefined),
      sendRevistoriaAprovadaSemBoletoEmail: jest
        .fn()
        .mockResolvedValue(undefined),
    };
  });

  describe('lease: uma tentativa por vez', () => {
    it('duplo clique em aprovar: UMA chamada de criação ao SGA', async () => {
      const { servico, linha } = montar();

      const [a, b] = await Promise.all([
        servico.processar(10, { origem: 'APROVACAO' }),
        servico.processar(10, { origem: 'APROVACAO' }),
      ]);

      expect(criacao.criarBoletoReativacao).toHaveBeenCalledTimes(1);
      expect(client.listarBoletosParaAdocao).toHaveBeenCalledTimes(1);
      expect([a.pulado, b.pulado].sort()).toEqual([false, true]);
      expect(linha).toMatchObject({
        boletoStatus: 'GERADO',
        boletoTentativas: 1,
        boletoNossoNumero: '555',
      });
      expect(mail.sendRevistoriaAprovadaEmail).toHaveBeenCalledTimes(1);
    });

    it('"Gerar agora" enquanto a aprovação ainda fala com o SGA: lê o estado já incrementado e mesmo assim NÃO chama o SGA', async () => {
      // É a corrida que o lock por `boletoTentativas` deixava passar: quem
      // lia depois do incremento via o mesmo número e seguia para o SGA.
      const { servico, linha } = montar();
      const sga = adiada<typeof boletoCriado>();
      criacao.criarBoletoReativacao.mockReturnValue(sga.promessa);

      const aprovacao = servico.processar(10, { origem: 'APROVACAO' });
      await ateQue(() => criacao.criarBoletoReativacao.mock.calls.length === 1);

      // No meio da tentativa a revistoria já aparece "em retry", com o lease
      // e a próxima tentativa no vencimento dele: se o processo morrer aqui,
      // a varredura retoma sozinha.
      expect(linha).toMatchObject({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 1,
      });
      expect(linha.boletoLeaseDono).toEqual(expect.any(String));
      expect(linha.boletoProximaTentativaEm).toEqual(linha.boletoLeaseAte);

      const manual = await servico.processar(10, { origem: 'MANUAL' });
      const retry = await servico.processar(10, { origem: 'RETRY' });

      expect(manual).toMatchObject({
        pulado: true,
        status: 'PENDENTE_RETRY',
        tentativas: 1,
      });
      expect(retry.pulado).toBe(true);
      expect(criacao.criarBoletoReativacao).toHaveBeenCalledTimes(1);
      expect(client.listarBoletosParaAdocao).toHaveBeenCalledTimes(1);

      sga.resolver(boletoCriado);
      expect(await aprovacao).toMatchObject({
        status: 'GERADO',
        pulado: false,
      });
      expect(linha.boletoTentativas).toBe(1);
    });

    it('varredura de retry junto com "Gerar agora": só uma tentativa passa', async () => {
      const { servico } = montar({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 3,
        boletoRetryInicioEm: new Date(Date.now() - 30 * MIN),
        boletoProximaTentativaEm: new Date(Date.now() - MIN),
      });

      const resultados = await Promise.all([
        servico.processar(10, { origem: 'RETRY' }),
        servico.processar(10, { origem: 'MANUAL' }),
      ]);

      expect(criacao.criarBoletoReativacao).toHaveBeenCalledTimes(1);
      expect(resultados.filter((r) => r.pulado)).toHaveLength(1);
      expect(resultados.filter((r) => r.status === 'GERADO')).toHaveLength(1);
    });

    it('o lease é reivindicado ANTES de qualquer chamada ao SGA', async () => {
      const { servico, linha } = montar();
      client.listarBoletosParaAdocao.mockImplementation(() => {
        expect(linha.boletoLeaseDono).toEqual(expect.any(String));
        expect((linha.boletoLeaseAte as Date).getTime()).toBeGreaterThan(
          Date.now() + BOLETO_LEASE_MS - 5_000,
        );
        return Promise.resolve([]);
      });

      await servico.processar(10, { origem: 'APROVACAO' });

      expect(client.listarBoletosParaAdocao).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['GERADO', () => undefined],
      [
        'PENDENTE_RETRY',
        () =>
          client.listarBoletosParaAdocao.mockRejectedValue(
            new BoletoReativacaoInstabilidadeError('HTTP 503', 'listar', 503),
          ),
      ],
      [
        'FALHA',
        () =>
          criacao.criarBoletoReativacao.mockRejectedValue(
            new TypeError('x is not a function'),
          ),
      ],
    ])('o lease é solto ao terminar em %s', async (status, preparar) => {
      const { servico, linha } = montar();
      preparar();

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe(status);
      expect(linha.boletoLeaseAte).toBeNull();
      expect(linha.boletoLeaseDono).toBeNull();
    });

    it('lease vencido (processo morreu no meio): a tentativa seguinte assume', async () => {
      const { servico, linha } = montar({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 1,
        boletoLeaseDono: 'processo-morto',
        boletoLeaseAte: new Date(Date.now() - MIN),
        boletoProximaTentativaEm: new Date(Date.now() - MIN),
        boletoRetryInicioEm: new Date(Date.now() - 11 * MIN),
      });

      const r = await servico.processar(10, { origem: 'RETRY' });

      expect(r).toMatchObject({ status: 'GERADO', tentativas: 2 });
      expect(linha.boletoLeaseDono).toBeNull();
    });

    it('lease ainda válido de outro dono: nem a tentativa manual passa', async () => {
      const { servico } = montar({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 1,
        boletoLeaseDono: 'outro-processo',
        boletoLeaseAte: new Date(Date.now() + 5 * MIN),
      });

      const r = await servico.processar(10, { origem: 'MANUAL' });

      expect(r.pulado).toBe(true);
      expect(client.listarBoletosParaAdocao).not.toHaveBeenCalled();
      expect(criacao.criarBoletoReativacao).not.toHaveBeenCalled();
    });

    it('lease perdido durante a tentativa: a falha NÃO sobrescreve o estado de quem assumiu', async () => {
      const { servico, linha } = montar();
      client.listarBoletosParaAdocao.mockImplementation(() => {
        // Outra tentativa assumiu a revistoria (o lease desta venceu).
        Object.assign(linha, { boletoLeaseDono: 'quem-assumiu' });
        return Promise.reject(
          new BoletoReativacaoInstabilidadeError('HTTP 503', 'listar', 503),
        );
      });

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.pulado).toBe(true);
      expect(linha.boletoLeaseDono).toBe('quem-assumiu');
      expect(linha.boletoUltimoErro).toBeNull();
      expect(mail.sendRevistoriaAprovadaSemBoletoEmail).not.toHaveBeenCalled();
    });

    it('lease perdido depois de cadastrar: o boleto existe, então GERADO é gravado mesmo assim — sem tocar o lease do outro', async () => {
      const { servico, linha } = montar();
      criacao.criarBoletoReativacao.mockImplementation(() => {
        Object.assign(linha, { boletoLeaseDono: 'quem-assumiu' });
        return Promise.resolve(boletoCriado);
      });

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe('GERADO');
      expect(linha).toMatchObject({
        boletoStatus: 'GERADO',
        boletoNossoNumero: '555',
        boletoLeaseDono: 'quem-assumiu',
      });
    });
  });

  describe('retry só de quem está aguardando, e só na hora', () => {
    it('retry antes da hora marcada: ignorado, sem reivindicar o lease', async () => {
      const proxima = new Date(Date.now() + 3 * MIN);
      const { servico, prisma } = montar({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 2,
        boletoProximaTentativaEm: proxima,
      });

      const r = await servico.processar(10, { origem: 'RETRY' });

      expect(r).toMatchObject({
        pulado: true,
        status: 'PENDENTE_RETRY',
        proximaTentativaEm: proxima,
      });
      expect(prisma.reinspection.updateMany).not.toHaveBeenCalled();
      expect(client.listarBoletosParaAdocao).not.toHaveBeenCalled();
    });

    it('job de retry antigo para revistoria em FALHA: não ressuscita a tentativa nem reenvia e-mail', async () => {
      const { servico, prisma } = montar({
        boletoStatus: 'FALHA',
        boletoTentativas: 4,
      });

      const r = await servico.processar(10, { origem: 'RETRY' });

      expect(r).toMatchObject({ pulado: true, status: 'FALHA' });
      expect(prisma.reinspection.updateMany).not.toHaveBeenCalled();
      expect(criacao.criarBoletoReativacao).not.toHaveBeenCalled();
      expect(mail.sendRevistoriaAprovadaSemBoletoEmail).not.toHaveBeenCalled();
    });

    it('a tentativa manual não espera a hora do retry', async () => {
      const { servico } = montar({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 2,
        boletoProximaTentativaEm: new Date(Date.now() + 3 * MIN),
      });

      const r = await servico.processar(10, { origem: 'MANUAL' });

      expect(r.status).toBe('GERADO');
    });
  });

  describe('erro definitivo vai para FALHA; só instabilidade comprovada agenda nova tentativa', () => {
    it('dono do veículo sem base: FALHA na hora, sem tocar o SGA e sem usar a base padrão', async () => {
      const { servico, linha } = montar({
        userVehicle: {
          id: 5,
          chassi: 'CHASSI123',
          plate: 'ABC1D23',
          user: { cpf: '529.982.247-25', baseOrigin: null },
        },
      });
      const antes = await contador('falha_geracao');

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe('FALHA');
      expect(r.erro).toContain('base do associado não resolvida');
      expect(linha.boletoUltimoErro).toContain(
        'base do associado não resolvida',
      );
      expect(linha.boletoProximaTentativaEm).toBeNull();
      expect(client.listarBoletosParaAdocao).not.toHaveBeenCalled();
      expect(criacao.criarBoletoReativacao).not.toHaveBeenCalled();
      expect(mail.sendRevistoriaAprovadaSemBoletoEmail).toHaveBeenCalledTimes(
        1,
      );
      expect(await contador('falha_geracao')).toBe(antes + 1);
    });

    it('base que não pertence ao deploy: também FALHA', async () => {
      const { servico } = montar({
        userVehicle: {
          id: 5,
          chassi: 'CHASSI123',
          plate: 'ABC1D23',
          user: { cpf: '529.982.247-25', baseOrigin: 'OUTRA_EMPRESA' },
        },
      });

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe('FALHA');
      expect(client.listarBoletosParaAdocao).not.toHaveBeenCalled();
    });

    it('exceção desconhecida (defeito de programação): FALHA com o erro gravado — não 288 tentativas', async () => {
      const { servico, linha } = montar();
      criacao.criarBoletoReativacao.mockRejectedValue(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
      );

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe('FALHA');
      expect(linha.boletoUltimoErro).toContain('Cannot read properties');
      expect(linha.boletoProximaTentativaEm).toBeNull();
    });

    it('credencial da Hinova ausente para a base (definitivo na taxonomia): FALHA', async () => {
      const { servico } = montar();
      client.listarBoletosParaAdocao.mockRejectedValue(
        erroDaExcecaoSga(
          'listar/boleto-associado-veiculo',
          new IntegrationError({ vendor: 'hinova', tipo: 'nao_configurada' }),
        ),
      );

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe('FALHA');
    });

    it.each([
      [
        'disjuntor da Hinova aberto',
        new IntegrationError({ vendor: 'hinova', tipo: 'circuito_aberto' }),
      ],
      [
        'login no SGA recusado (token bloqueado)',
        new FalhaAutenticacaoSga('Falha ao autenticar no SGA', true),
      ],
      [
        'timeout de rede',
        Object.assign(new Error('timeout of 60000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ],
      [
        'banco fora',
        Object.assign(new Error("Can't reach database server"), {
          code: 'P1001',
        }),
      ],
    ])(
      '%s: PENDENTE_RETRY com a próxima tentativa agendada',
      async (_caso, erro) => {
        const { servico, linha } = montar();
        criacao.criarBoletoReativacao.mockRejectedValue(erro);
        const antes = Date.now();

        const r = await servico.processar(10, { origem: 'APROVACAO' });

        expect(r.status).toBe('PENDENTE_RETRY');
        expect(
          (linha.boletoProximaTentativaEm as Date).getTime(),
        ).toBeGreaterThanOrEqual(antes + 5 * MIN - 50);
        expect(linha.boletoUltimoErro).toEqual(expect.any(String));
        expect(
          mail.sendRevistoriaAprovadaSemBoletoEmail,
        ).not.toHaveBeenCalled();
      },
    );
  });

  describe('boleto cadastrado no SGA, mas a gravação local falhou', () => {
    const semRegistro = (causa: unknown) =>
      new BoletoCadastradoSemRegistroError(
        {
          nossoNumero: '555',
          linhaDigitavel: '0001',
          linkBoleto: 'https://sga/boleto/555',
        },
        causa,
      );

    it('NÃO marca GERADO: fica em retry com o nosso_numero anotado', async () => {
      const { servico, linha } = montar();
      criacao.criarBoletoReativacao.mockRejectedValue(
        semRegistro(
          Object.assign(new Error('pool esgotado'), { code: 'P2024' }),
        ),
      );

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r).toMatchObject({ status: 'PENDENTE_RETRY', nossoNumero: '555' });
      expect(linha).toMatchObject({
        boletoStatus: 'PENDENTE_RETRY',
        boletoNossoNumero: '555',
        boletoOrigem: 'CRIADO_APP',
      });
      expect(linha.boletoUltimoErro).toContain('JÁ CADASTRADO');
      expect(mail.sendRevistoriaAprovadaEmail).not.toHaveBeenCalled();
    });

    it('a tentativa seguinte RETOMA o boleto: grava o pagamento e nunca cadastra outro', async () => {
      const { servico, linha } = montar();
      criacao.criarBoletoReativacao.mockRejectedValueOnce(
        semRegistro(
          Object.assign(new Error('pool esgotado'), { code: 'P2024' }),
        ),
      );
      await servico.processar(10, { origem: 'APROVACAO' });
      Object.assign(linha, {
        boletoProximaTentativaEm: new Date(Date.now() - 1_000),
      });
      client.listarBoletosParaAdocao.mockResolvedValue([
        { nosso_numero: 555, link_boleto: 'https://sga/boleto/555' },
      ]);

      const r = await servico.processar(10, { origem: 'RETRY' });

      expect(criacao.criarBoletoReativacao).toHaveBeenCalledTimes(1);
      expect(criacao.registrarPagamentoBoleto).toHaveBeenCalledWith(
        expect.objectContaining({
          reinspectionId: 10,
          nossoNumero: '555',
          linkBoleto: 'https://sga/boleto/555',
          baseOrigin: 'MAIS_PRIME',
          codigoVeiculo: '777',
        }),
      );
      // A situação do veículo, que o cadastro não chegou a aplicar.
      expect(criacao.aplicarSituacaoAposBoleto).toHaveBeenCalledWith(
        'MAIS_PRIME',
        '777',
        20,
      );
      expect(r).toMatchObject({
        status: 'GERADO',
        nossoNumero: '555',
        adotado: false,
      });
      expect(linha).toMatchObject({
        boletoStatus: 'GERADO',
        boletoOrigem: 'CRIADO_APP',
      });
    });

    it('retomada sem o boleto na listagem do SGA: grava o pagamento mesmo assim (sem link), sem cadastrar', async () => {
      const { servico } = montar({
        boletoStatus: 'FALHA',
        boletoTentativas: 1,
        boletoNossoNumero: '555',
        boletoOrigem: 'CRIADO_APP',
      });
      client.listarBoletosParaAdocao.mockResolvedValue(null);

      const r = await servico.processar(10, { origem: 'MANUAL' });

      expect(criacao.criarBoletoReativacao).not.toHaveBeenCalled();
      expect(criacao.registrarPagamentoBoleto).toHaveBeenCalledWith(
        expect.objectContaining({ nossoNumero: '555', linkBoleto: null }),
      );
      expect(r.status).toBe('GERADO');
    });

    it('causa definitiva (dado que não cabe na coluna): FALHA avisando a cobrança para NÃO gerar outro', async () => {
      const { servico, linha } = montar();
      criacao.criarBoletoReativacao.mockRejectedValue(
        semRegistro(
          Object.assign(new Error('value too long'), { code: 'P2000' }),
        ),
      );

      const r = await servico.processar(10, { origem: 'APROVACAO' });

      expect(r.status).toBe('FALHA');
      expect(linha.boletoNossoNumero).toBe('555');
      expect(mail.sendRevistoriaAprovadaSemBoletoEmail).toHaveBeenCalledWith(
        'CHASSI123',
        'ABC1D23',
        expect.stringContaining(
          'Boleto 555 JÁ CADASTRADO no SGA (não gere outro)',
        ),
        undefined,
      );
    });
  });

  it('adoção procura primeiro pela referência REV-<id> da revistoria', async () => {
    const { servico } = montar();
    const amanha = new Date(Date.now() + 86_400_000);
    const br = `${String(amanha.getDate()).padStart(2, '0')}/${String(amanha.getMonth() + 1).padStart(2, '0')}/${amanha.getFullYear()}`;
    client.listarBoletosParaAdocao.mockResolvedValue([
      {
        nosso_numero: 1,
        codigo_situacao_boleto: 2,
        codigo_tipo_boleto: 2,
        data_vencimento_original: br,
      },
      {
        nosso_numero: 2,
        codigo_situacao_boleto: 2,
        codigo_tipo_boleto: 2,
        data_vencimento_original: br,
        referencia: [{ descricao: 'Boleto reativação app REV-10' }],
      },
    ]);

    const r = await servico.processar(10, { origem: 'APROVACAO' });

    expect(r).toMatchObject({
      status: 'GERADO',
      adotado: true,
      nossoNumero: '2',
    });
    expect(criacao.criarBoletoReativacao).not.toHaveBeenCalled();
  });

  it('conta `gerado` em boleto_reativacao_total', async () => {
    const { servico } = montar();
    const antes = await contador('gerado');

    await servico.processar(10, { origem: 'APROVACAO' });

    expect(await contador('gerado')).toBe(antes + 1);
  });
});
