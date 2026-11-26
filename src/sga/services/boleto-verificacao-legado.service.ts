import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { metricas } from 'src/infra/observability/metricas';
import { baseDoJob } from 'src/queue/job-envelope';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';
import { debugLog } from 'src/shared/debug-log.util';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import {
  BoletoVerificacaoConfig,
  JOB_ID_PREFIXO_VERIFICACAO,
  JOB_VERIFICAR_BOLETO,
  deveConsultarSga,
  excedeuIdadeMaxima,
  getBoletoVerificacaoConfig,
} from 'src/sga/config/boleto-verificacao.config';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';

/** Payload do job repetível antigo (um por boleto). */
export interface BoletoVerificacaoJobData {
  userVehicleId: number;
  nosso_numero: number | string;
  codigo_veiculo: string;
  codigo_associado?: number;
  /** Ausente (ou fora das bases do deploy) em pollers antigos. */
  baseOrigin?: BaseOrigin;
  nome?: string;
  telefone_celular?: string;
  debugId?: string;
}

/** Agendador como o BullMQ instalado (5.69) devolve em `getJobSchedulers`. */
interface AgendadorDoBullmq {
  key: string;
  name?: string;
  id?: string | null;
  next?: number;
}

/**
 * Jobs repetíveis ANTIGOS de verificação de pagamento — um por boleto,
 * criados antes da varredura e ainda gravados no Redis.
 *
 * Eles continuam sendo atendidos com o payload que têm, pelo mesmo caminho
 * de verificação da varredura; só a cadência (pelo `updatedAt` da linha) e o
 * encerramento (remover o repetível) são próprios daqui. Boleto novo não
 * cria mais repetível: quando o último destes encerrar, esta classe pode
 * ser removida.
 */
@Injectable()
export class BoletoVerificacaoLegadoService {
  private readonly logger = new Logger(BoletoVerificacaoLegadoService.name);
  private readonly config: BoletoVerificacaoConfig =
    getBoletoVerificacaoConfig();

  constructor(
    private readonly pagamentos: PagamentoBoletoRepository,
    private readonly verificacao: VerificarPagamentoBoletoService,
    @InjectQueue(BOLETO_VERIFICACAO_QUEUE as string)
    private readonly fila: Queue,
  ) {}

  async atender(job: Job<BoletoVerificacaoJobData>): Promise<void> {
    const dados = job.data;
    const nossoNumero = String(dados.nosso_numero);
    const agora = Date.now();
    const pagamento = await this.pagamentos.buscarPorNossoNumero(nossoNumero);

    if (pagamento) {
      // A linha já está na varredura (boleto regravado pelo fluxo novo) ou
      // já foi encerrada: este repetível não tem mais o que fazer.
      if (pagamento.proximaConsultaEm || pagamento.verificacaoEncerradaEm) {
        await this.encerrarPoller(job);
        return;
      }

      const criadoEm = pagamento.boletoCriadoEm.getTime();
      if (excedeuIdadeMaxima(this.config, criadoEm, agora)) {
        this.logger.warn(
          debugLog(
            BoletoVerificacaoLegadoService.name,
            'Verificação encerrada: boleto além da idade máxima',
            dados.debugId,
            {
              nossoNumero,
              boletoCriadoEm: pagamento.boletoCriadoEm.toISOString(),
              maxDias: this.config.maxDias,
              pago: pagamento.pago,
            },
          ),
        );
        metricas.boletoReativacao.inc({
          base: baseDoJob(dados) ?? 'n/a',
          evento: 'expirado',
        });
        await this.pagamentos.encerrar(nossoNumero, new Date(agora));
        await this.encerrarPoller(job);
        return;
      }

      // Cadência por idade, decidida pelo banco, sem tocar o SGA. Pago no
      // banco com o poller ainda ativo (a reativação não foi aceita): vai
      // direto ao SGA para concluir.
      if (
        !pagamento.pago &&
        !deveConsultarSga(this.config, {
          criadoEm,
          ultimaConsultaEm: pagamento.updatedAt.getTime(),
          agora,
        })
      ) {
        return;
      }
    }

    // Só a partir daqui o job fala com o SGA: a base é resolvida uma vez.
    const base = await this.resolverBase(dados);
    const desfecho = await this.verificacao.verificar(
      {
        userVehicleId: dados.userVehicleId,
        nossoNumero,
        codigoVeiculo: String(dados.codigo_veiculo),
        codigoAssociado: dados.codigo_associado ?? null,
        nomeAssociado: dados.nome ?? null,
        telefoneAssociado: dados.telefone_celular ?? null,
        debugId: dados.debugId,
      },
      base,
      pagamento,
    );

    if (desfecho === 'CANCELADO' || desfecho === 'PAGO_E_REATIVADO') {
      await this.encerrarPoller(job);
    }
  }

  /**
   * Limpeza de boot dos repetíveis antigos. Remove os que não têm mais o que
   * fazer: boleto além da idade máxima, verificação já encerrada, linha que
   * passou para a varredura e o SEGUNDO repetível do mesmo boleto (o
   * `endDate` entrava na chave, então regravar o boleto criava outro).
   *
   * O BullMQ instalado não devolve o `jobId` do repetível (a chave é um
   * hash): o `nosso_numero` vem do próximo job já agendado
   * (`repeat:<key>:<next>`), que carrega o payload. Repetíveis de versões
   * antigas, com o id na própria chave, seguem reconhecidos por ele.
   */
  async limparPollers(): Promise<{ ativos: number; removidos: number }> {
    const agendadores = (await this.fila.getJobSchedulers()) as Array<
      AgendadorDoBullmq | undefined
    >;
    const pollers = agendadores.filter(
      (a): a is AgendadorDoBullmq => !!a && a.name === JOB_VERIFICAR_BOLETO,
    );
    const agora = Date.now();
    const vistos = new Set<string>();
    let removidos = 0;

    for (const poller of pollers) {
      const nossoNumero = await this.nossoNumeroDoPoller(poller);
      if (!nossoNumero) continue;

      const motivo = await this.motivoParaRemover(nossoNumero, vistos, agora);
      vistos.add(nossoNumero);
      if (!motivo) continue;

      await this.fila.removeRepeatableByKey(poller.key);
      removidos += 1;
      this.logger.warn(
        `Poller do boleto nosso_numero=${nossoNumero} encerrado no boot: ${motivo}.`,
      );
    }

    return { ativos: pollers.length - removidos, removidos };
  }

  private async motivoParaRemover(
    nossoNumero: string,
    vistos: Set<string>,
    agora: number,
  ): Promise<string | null> {
    if (vistos.has(nossoNumero)) return 'repetível duplicado do mesmo boleto';

    const pagamento = await this.pagamentos.buscarPorNossoNumero(nossoNumero);
    if (!pagamento) return null;
    if (pagamento.verificacaoEncerradaEm) return 'verificação já encerrada';
    if (pagamento.proximaConsultaEm) return 'boleto já está na varredura';
    if (
      excedeuIdadeMaxima(this.config, pagamento.boletoCriadoEm.getTime(), agora)
    ) {
      return `criado em ${pagamento.boletoCriadoEm.toISOString()}, além da idade máxima`;
    }
    return null;
  }

  private async nossoNumeroDoPoller(
    poller: AgendadorDoBullmq,
  ): Promise<string | null> {
    if (poller.id?.startsWith(JOB_ID_PREFIXO_VERIFICACAO)) {
      return poller.id.slice(JOB_ID_PREFIXO_VERIFICACAO.length);
    }
    if (!poller.next) return null;

    const proximo = (await this.fila.getJob(
      `repeat:${poller.key}:${poller.next}`,
    )) as Job<Partial<BoletoVerificacaoJobData>> | undefined;
    const numero = proximo?.data?.nosso_numero;
    return numero != null ? String(numero) : null;
  }

  /**
   * Base do job. Usa a do payload quando ela é uma das bases do deploy; um
   * poller antigo, sem a base no payload, rederiva do dono do veículo. Sem
   * base válida o job falha de vez (`BaseNaoResolvidaError`) em vez de
   * consultar o SGA com a credencial de outra base.
   */
  private async resolverBase(
    dados: BoletoVerificacaoJobData,
  ): Promise<BaseOrigin> {
    const doPayload = baseDoJob(dados);
    if (doPayload) return doPayload;
    return exigirBase(
      await this.pagamentos.baseDoDonoDoVeiculo(dados.userVehicleId),
      'job boleto-verificacao (user.baseOrigin do veículo)',
    );
  }

  /** Remove o repeatable deste boleto (encerra o poller). */
  private async encerrarPoller(job: Job<BoletoVerificacaoJobData>) {
    if (job.repeatJobKey) {
      await this.fila.removeRepeatableByKey(job.repeatJobKey);
    }
  }
}
