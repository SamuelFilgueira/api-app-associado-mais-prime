import { resetTenantConfigCache } from 'src/config/tenant.config';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { BOLETO_LEASE_MS } from 'src/sga/domain/boleto-geracao';
import { BoletoReativacaoInstabilidadeError } from 'src/sga/errors/boleto-reativacao.error';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { BoletoAdocaoService } from 'src/sga/services/boleto-adocao.service';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { BoletoDesfechoService } from 'src/sga/services/boleto-desfecho.service';
import { BoletoObtencaoService } from 'src/sga/services/boleto-obtencao.service';
import { BoletoRetryVarreduraService } from 'src/sga/services/boleto-retry-varredura.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const MARCA = `it-boleto-lease-${process.pid}`;
const MIN = 60_000;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lease da geração do boleto de reativação contra o banco real: várias
 * tentativas simultâneas para a mesma revistoria (aprovação com duplo
 * clique, "Gerar agora", varredura de retry) resultam em UMA chamada de
 * criação ao SGA. O SGA é simulado; o que está em prova é a escrita
 * condicional no MariaDB.
 */
describeComBanco('Banco real — lease do boleto de reativação', () => {
  let prisma: PrismaService;
  let revistorias: BoletoReativacaoRepository;
  let userId: number;
  let userVehicleId: number;
  let reinspectionId: number;
  const basesOriginais = process.env.TENANT_BASES;

  /** Chamadas de criação "ao SGA", com a demora de uma chamada de verdade. */
  let criacoes: number;
  let listagens: number;
  let demoraDoSgaMs: number;
  let falharCom: Error | null;

  const montar = () => {
    const client = {
      listarBoletosParaAdocao: async () => {
        listagens += 1;
        await dormir(demoraDoSgaMs);
        return [];
      },
    };
    const criacao = {
      criarBoletoReativacao: async () => {
        criacoes += 1;
        await dormir(demoraDoSgaMs);
        if (falharCom) throw falharCom;
        return {
          nossoNumero: `${MARCA}-${criacoes}`,
          linkBoleto: 'https://sga/boleto',
          suriEnviada: true,
        };
      },
    };
    const mail = {
      sendRevistoriaAprovadaEmail: () => Promise.resolve(),
      sendRevistoriaAprovadaSemBoletoEmail: () => Promise.resolve(),
    };
    return new GerarBoletoReativacaoService(
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
  };

  /**
   * Varredura restrita à revistoria deste arquivo: o banco de teste é
   * compartilhado, e a varredura de verdade pegaria as de outras suítes.
   */
  const varreduraDoTeste = (servico: GerarBoletoReativacaoService) => {
    const soAMinha = Object.create(revistorias) as BoletoReativacaoRepository;
    soAMinha.listarRetriesVencidos = async (agora: Date) =>
      (await revistorias.listarRetriesVencidos(agora, 500)).filter(
        (id) => id === reinspectionId,
      );
    return new BoletoRetryVarreduraService(soAMinha, servico);
  };

  const linha = () =>
    prisma.reinspection.findUniqueOrThrow({ where: { id: reinspectionId } });

  const redefinir = (dados: Record<string, unknown> = {}) =>
    prisma.reinspection.update({
      where: { id: reinspectionId },
      data: {
        boletoStatus: 'NAO_GERADO',
        boletoTentativas: 0,
        boletoUltimaTentativaEm: null,
        boletoProximaTentativaEm: null,
        boletoRetryInicioEm: null,
        boletoUltimoErro: null,
        boletoNossoNumero: null,
        boletoOrigem: null,
        boletoLeaseAte: null,
        boletoLeaseDono: null,
        ...dados,
      },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    // O Prisma recarrega o `.env` da máquina ao instanciar o client: as
    // bases do teste são fixadas depois disso.
    process.env.TENANT_BASES = 'MAIS_PRIME:,MAIS_PRIME_RS:_RS';
    resetTenantConfigCache();
    revistorias = new BoletoReativacaoRepository(prisma);

    const usuario = await prisma.user.create({
      data: {
        name: MARCA,
        cpf: `7${String(process.pid).padStart(10, '0')}`.slice(0, 11),
        email: `${MARCA}@teste.local`,
        passwordHash: 'x',
        baseOrigin: 'MAIS_PRIME',
      },
    });
    userId = usuario.id;
    const veiculo = await prisma.userVehicle.create({
      data: { userId, chassi: `CH${process.pid}LEASE`, plate: 'ABC1D23' },
    });
    userVehicleId = veiculo.id;
    const revistoria = await prisma.reinspection.create({
      data: {
        userVehicleId,
        vehicleType: 'VEICULOS_LEVES',
        status: 'APROVADA',
        codigoVeiculo: 777,
      },
    });
    reinspectionId = revistoria.id;
  });

  afterAll(async () => {
    // Apaga só o que este arquivo criou (revistoria e veículo saem em cascata).
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    if (basesOriginais === undefined) delete process.env.TENANT_BASES;
    else process.env.TENANT_BASES = basesOriginais;
    resetTenantConfigCache();
  });

  beforeEach(async () => {
    criacoes = 0;
    listagens = 0;
    demoraDoSgaMs = 60;
    falharCom = null;
    await redefinir();
  });

  it('8 aprovações simultâneas da mesma revistoria: UMA criação no SGA', async () => {
    const servico = montar();

    const resultados = await Promise.all(
      Array.from({ length: 8 }, () =>
        servico.processar(reinspectionId, { origem: 'APROVACAO' }),
      ),
    );

    expect(criacoes).toBe(1);
    expect(listagens).toBe(1);
    expect(resultados.filter((r) => !r.pulado)).toHaveLength(1);
    expect(resultados.filter((r) => r.pulado)).toHaveLength(7);
    expect(await linha()).toMatchObject({
      boletoStatus: 'GERADO',
      boletoTentativas: 1,
      boletoNossoNumero: `${MARCA}-1`,
      boletoOrigem: 'CRIADO_APP',
      boletoLeaseAte: null,
      boletoLeaseDono: null,
    });
  });

  it('"Gerar agora" e varredura de retry chegando DEPOIS do incremento, com a aprovação ainda no SGA: nenhuma chama o SGA', async () => {
    // A corrida que o lock por `boletoTentativas` deixava passar: quem lê
    // depois do incremento encontra o mesmo número e seguia para o SGA.
    const servico = montar();
    demoraDoSgaMs = 400;

    const aprovacao = servico.processar(reinspectionId, {
      origem: 'APROVACAO',
    });
    await dormir(120);

    const noMeio = await linha();
    expect(noMeio.boletoTentativas).toBe(1);
    expect(noMeio.boletoStatus).toBe('PENDENTE_RETRY');
    expect(noMeio.boletoLeaseDono).toEqual(expect.any(String));
    expect(noMeio.boletoLeaseAte!.getTime()).toBeGreaterThan(
      Date.now() + BOLETO_LEASE_MS - 30_000,
    );

    const varredura = varreduraDoTeste(servico);
    const [manual, retry, resumo] = await Promise.all([
      servico.processar(reinspectionId, { origem: 'MANUAL' }),
      servico.processar(reinspectionId, { origem: 'RETRY' }),
      varredura.executar(),
    ]);

    expect(manual.pulado).toBe(true);
    expect(retry.pulado).toBe(true);
    // Com o lease em vigor a revistoria nem aparece para a varredura.
    expect(resumo.vencidas).toBe(0);
    expect((await aprovacao).status).toBe('GERADO');
    expect(criacoes).toBe(1);
    expect(listagens).toBe(1);
  });

  it('retry vencido: varredura em dois processos + "Gerar agora" → uma tentativa só', async () => {
    await redefinir({
      boletoStatus: 'PENDENTE_RETRY',
      boletoTentativas: 3,
      boletoRetryInicioEm: new Date(Date.now() - 30 * MIN),
      boletoProximaTentativaEm: new Date(Date.now() - MIN),
    });
    const servico = montar();
    const varreduraA = varreduraDoTeste(servico);
    const varreduraB = varreduraDoTeste(servico);

    await Promise.all([
      varreduraA.executar(),
      varreduraB.executar(),
      servico.processar(reinspectionId, { origem: 'MANUAL' }),
    ]);

    expect(criacoes).toBe(1);
    expect(await linha()).toMatchObject({
      boletoStatus: 'GERADO',
      boletoTentativas: 4,
    });
  });

  it('reivindicação direta: de duas com a mesma leitura, só uma ganha; a seguinte só depois que o lease vence', async () => {
    const reivindicar = (dono: string, tentativasLidas: number, agora: Date) =>
      revistorias.reivindicarLease({
        reinspectionId,
        dono,
        agora,
        leaseMs: BOLETO_LEASE_MS,
        tentativasLidas,
        estadosPermitidos: ['NAO_GERADO', 'PENDENTE_RETRY', 'FALHA'],
        inicioDaJanela: agora,
      });
    const agora = new Date();

    const simultaneas = await Promise.all(
      ['a', 'b', 'c', 'd'].map((dono) => reivindicar(dono, 0, agora)),
    );
    expect(simultaneas.filter(Boolean)).toHaveLength(1);

    // Quem lê depois do incremento (tentativas = 1) esbarra no lease.
    expect(await reivindicar('e', 1, new Date())).toBe(false);

    // Lease vencido (o dono morreu): a próxima tentativa assume.
    const depoisDoLease = new Date(agora.getTime() + BOLETO_LEASE_MS + 1_000);
    expect(await reivindicar('f', 1, depoisDoLease)).toBe(true);
    expect((await linha()).boletoLeaseDono).toBe('f');
  });

  it('revistoria com boleto GERADO nunca é reivindicada', async () => {
    await redefinir({ boletoStatus: 'GERADO', boletoNossoNumero: '1' });

    const ganhou = await revistorias.reivindicarLease({
      reinspectionId,
      dono: 'x',
      agora: new Date(),
      leaseMs: BOLETO_LEASE_MS,
      tentativasLidas: 0,
      estadosPermitidos: ['NAO_GERADO', 'PENDENTE_RETRY', 'FALHA'],
      inicioDaJanela: new Date(),
    });

    expect(ganhou).toBe(false);
    expect(
      await montar().processar(reinspectionId, { origem: 'APROVACAO' }),
    ).toMatchObject({ pulado: true, status: 'GERADO' });
    expect(criacoes).toBe(0);
  });

  it('instabilidade: PENDENTE_RETRY com a próxima tentativa, lease solto; a varredura só pega depois de vencer', async () => {
    const servico = montar();
    falharCom = new BoletoReativacaoInstabilidadeError(
      'boleto/cadastrar: SGA respondeu HTTP 503',
      'boleto/cadastrar',
      503,
    );

    const r = await servico.processar(reinspectionId, { origem: 'APROVACAO' });

    expect(r.status).toBe('PENDENTE_RETRY');
    const gravada = await linha();
    expect(gravada).toMatchObject({
      boletoStatus: 'PENDENTE_RETRY',
      boletoLeaseAte: null,
      boletoLeaseDono: null,
    });
    expect(gravada.boletoProximaTentativaEm!.getTime()).toBeGreaterThan(
      Date.now() + 4 * MIN,
    );

    // Ainda não venceu: a varredura não encontra nada.
    expect(
      await revistorias.listarRetriesVencidos(new Date(), 20),
    ).not.toContain(reinspectionId);
    // Venceu: aparece, e a tentativa gera o boleto.
    const depois = new Date(Date.now() + 6 * MIN);
    expect(await revistorias.listarRetriesVencidos(depois, 20)).toContain(
      reinspectionId,
    );
  });

  it('processo morto no meio (lease e estado ficam): a varredura retoma quando o lease vence', async () => {
    const agora = new Date();
    await revistorias.reivindicarLease({
      reinspectionId,
      dono: 'processo-morto',
      agora,
      leaseMs: BOLETO_LEASE_MS,
      tentativasLidas: 0,
      estadosPermitidos: ['NAO_GERADO'],
      inicioDaJanela: agora,
    });

    expect(
      await revistorias.listarRetriesVencidos(new Date(), 20),
    ).not.toContain(reinspectionId);
    const depoisDoLease = new Date(agora.getTime() + BOLETO_LEASE_MS + 1_000);
    expect(
      await revistorias.listarRetriesVencidos(depoisDoLease, 20),
    ).toContain(reinspectionId);
  });

  it('desfecho de quem perdeu o lease: a falha não é gravada; o boleto gerado é, sem tocar o lease do outro', async () => {
    const agora = new Date();
    await redefinir({
      boletoStatus: 'PENDENTE_RETRY',
      boletoTentativas: 2,
      boletoLeaseDono: 'quem-assumiu',
      boletoLeaseAte: new Date(agora.getTime() + 5 * MIN),
    });

    expect(
      await revistorias.agendarNovaTentativa({
        reinspectionId,
        dono: 'quem-perdeu',
        agora,
        tentativa: 2,
        proximaTentativaEm: new Date(agora.getTime() + 5 * MIN),
        inicioDaJanela: agora,
        erro: 'HTTP 503',
      }),
    ).toBe(false);
    expect(
      await revistorias.registrarFalha({
        reinspectionId,
        dono: 'quem-perdeu',
        agora,
        tentativa: 2,
        erro: 'definitivo',
      }),
    ).toBe(false);
    expect(await linha()).toMatchObject({
      boletoStatus: 'PENDENTE_RETRY',
      boletoUltimoErro: null,
      boletoLeaseDono: 'quem-assumiu',
    });

    expect(
      await revistorias.concluirGerado({
        reinspectionId,
        dono: 'quem-perdeu',
        agora,
        tentativa: 2,
        nossoNumero: '999',
        origem: 'CRIADO_APP',
      }),
    ).toBe('SEM_LEASE');
    expect(await linha()).toMatchObject({
      boletoStatus: 'GERADO',
      boletoNossoNumero: '999',
      boletoLeaseDono: 'quem-assumiu',
    });

    // Já gerado: uma segunda conclusão não sobrescreve o número.
    expect(
      await revistorias.concluirGerado({
        reinspectionId,
        dono: 'outro',
        agora,
        tentativa: 3,
        nossoNumero: '111',
        origem: 'ADOTADO_SGA',
      }),
    ).toBe('JA_GERADO');
    expect((await linha()).boletoNossoNumero).toBe('999');
  });
});
