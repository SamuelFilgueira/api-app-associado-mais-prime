/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- montagem de teste: os dublês entram no lugar dos tipos de produção */
import { ResultadoDaTrava } from 'src/infra/redis/trava.service';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import { loadBoletoNotificacaoConfig } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { ReguaDestinatarioRepository } from 'src/boleto-notificacao/repositories/regua-destinatario.repository';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';
import { ReguaLogRepository } from 'src/boleto-notificacao/repositories/regua-log.repository';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { ExecutarReguaService } from 'src/boleto-notificacao/services/executar-regua.service';
import { ReguaDaBaseService } from 'src/boleto-notificacao/services/regua-da-base.service';
import { ReguaEnvioService } from 'src/boleto-notificacao/services/regua-envio.service';
import { ReguaEtapaService } from 'src/boleto-notificacao/services/regua-etapa.service';
import { ReguaMetricaService } from 'src/boleto-notificacao/services/regua-metrica.service';
import { ReguaSelecaoService } from 'src/boleto-notificacao/services/regua-selecao.service';
import { PrismaDaReguaEmMemoria } from 'src/boleto-notificacao/testing/prisma-da-regua-em-memoria';

/** Lotes de 100, como o SDK do Expo fatia. */
function fatiar<T>(itens: T[], tamanho = 100): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }
  return lotes;
}

/**
 * Trava em memória com a mesma regra da `TravaService`: quem chega com a
 * chave ocupada recebe `{ executou: false }` na hora. `ocupadas` permite
 * simular a trava de outro processo.
 */
export class TravaFalsa {
  readonly ocupadas = new Set<string>();
  readonly pedidos: string[] = [];

  async tentar<T>(
    chave: string,
    _ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<ResultadoDaTrava<T>> {
    this.pedidos.push(chave);
    if (this.ocupadas.has(chave)) return { executou: false };
    this.ocupadas.add(chave);
    try {
      return { executou: true, valor: await fn() };
    } finally {
      this.ocupadas.delete(chave);
    }
  }
}

/**
 * Monta a régua inteira para os specs — casos de uso e repositórios REAIS —,
 * com o que é externo trocado por dublês: SGA (`sgaClient`), fila
 * (`produtor`), trava (`trava`) e o SDK do Expo (`expo`, por baixo do
 * `ExpoPushClient` real). Por padrão todo push é aceito, com ticket
 * `ticket:<token>`.
 */
export function montarRegua(
  opcoes: {
    env?: NodeJS.ProcessEnv;
    prisma?: any;
    trava?: any;
    /** Dublês do próprio spec, quando ele já tem os seus. */
    config?: { get: () => any };
    sgaClient?: { listarAbertosPorVencimento: jest.Mock };
    produtor?: { enfileirar: jest.Mock };
  } = {},
) {
  // Tipado como o dublê em memória: quem passa outro Prisma (mock do spec,
  // banco real) usa a própria referência para conferir o estado.
  const prisma: PrismaDaReguaEmMemoria =
    opcoes.prisma ?? new PrismaDaReguaEmMemoria();
  const config = opcoes.config ?? {
    get: () => loadBoletoNotificacaoConfig(opcoes.env ?? {}),
  };
  const sgaClient = opcoes.sgaClient ?? {
    listarAbertosPorVencimento: jest.fn(),
  };
  const produtor = opcoes.produtor ?? {
    enfileirar: jest.fn((..._args: unknown[]) =>
      Promise.resolve({ id: 'job-1' }),
    ),
  };
  const trava = opcoes.trava ?? new TravaFalsa();
  const expo = {
    chunkPushNotifications: (mensagens: unknown[]) => fatiar(mensagens),
    sendPushNotificationsAsync: jest.fn<Promise<any[]>, [any[]]>((mensagens) =>
      Promise.resolve(
        mensagens.map((m) => ({ status: 'ok', id: `ticket:${m.to}` })),
      ),
    ),
    chunkPushNotificationReceiptIds: (ids: string[]) => fatiar(ids, 300),
    getPushNotificationReceiptsAsync: jest.fn<
      Promise<Record<string, any>>,
      [string[]]
    >(() => Promise.resolve({})),
  };
  // O adaptador é o de produção; só o SDK por baixo dele é trocado.
  const push = new ExpoPushClient();
  (push as any).expo = expo;

  const execucoes = new ReguaExecucaoRepository(prisma as any);
  const logs = new ReguaLogRepository(prisma as any);
  const destinatarios = new ReguaDestinatarioRepository(prisma as any);
  const selecao = new ReguaSelecaoService(destinatarios, logs, push);
  const envio = new ReguaEnvioService(logs, destinatarios, push);
  const etapa = new ReguaEtapaService(
    config as any,
    execucoes,
    selecao,
    envio,
    produtor as any,
  );
  const reguaDaBase = new ReguaDaBaseService(
    config as any,
    sgaClient as any,
    execucoes,
    etapa,
  );
  const metrica = new ReguaMetricaService(execucoes, config as any);
  const regua = new ExecutarReguaService(
    config as any,
    reguaDaBase,
    trava,
    metrica,
  );
  // Quem aguarda a trava não dorme de verdade nos specs.
  const aguardar = jest
    .spyOn(regua as any, 'aguardar')
    .mockResolvedValue(undefined);
  const service = new BoletoNotificacaoService(regua, config as any);
  const receipts = new BoletoNotificacaoReceiptsService(
    execucoes,
    logs,
    destinatarios,
    push,
  );

  return {
    prisma,
    config,
    sgaClient,
    produtor,
    trava: trava as TravaFalsa,
    expo,
    push,
    selecao,
    regua,
    aguardar,
    metrica,
    service,
    receipts,
  };
}

/** Boleto já normalizado, como o `SgaBoletoPeriodoClient` devolve. */
export function boletoSga(overrides: Record<string, unknown> = {}) {
  return {
    nossoNumero: '1001',
    codigoAssociado: 55,
    nomeAssociado: 'KAIO DA SILVA',
    cpf: '52998224725',
    dataVencimento: '2026-09-10',
    dataVencimentoOriginal: '2026-09-10',
    codigoSituacaoBoleto: '2',
    codigoTipoBoleto: '1',
    tipoBoleto: 'MENSALIDADE',
    situacaoBoleto: 'ABERTO',
    valorBoleto: '99.90',
    mesReferente: '09/2026',
    veiculos: [{ codigo_veiculo: 1, placa: 'ABC1D23' }],
    ...overrides,
  };
}

export function consultaSga(
  boletos: unknown[],
  origem: 'SGA' | 'MOCK' = 'SGA',
) {
  return {
    boletos,
    totalRegistros: boletos.length,
    numeroPaginas: 1,
    paginasConsultadas: 1,
    duplicadosEntrePaginas: 0,
    origem,
  };
}
