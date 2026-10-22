import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import axios from 'axios';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { PrismaService } from 'src/database/prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { TENANT } from 'src/config/tenant.config';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { debugLog } from 'src/shared/debug-log.util';
import { formatDateBR } from 'src/shared/date.util';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';
import { BoletoReativacaoDefinitivoError } from 'src/sga/errors/boleto-reativacao.error';
import {
  erroDaExcecaoSga,
  erroDaRespostaSga,
} from 'src/sga/helpers/sga-instabilidade.helper';
import {
  INTERVALO_BASE_MS,
  JOB_ID_PREFIXO_VERIFICACAO,
  JOB_VERIFICAR_BOLETO,
  getBoletoVerificacaoConfig,
  prazoFinalPoller,
} from 'src/sga/config/boleto-verificacao.config';

type SgaVeiculo = {
  chassi?: string;
  placa?: string;
  codigo_veiculo?: string | number;
};

type SgaAssociadoResponse = {
  veiculos?: SgaVeiculo[];
};

@Injectable()
export class SgaService {
  private readonly logger = new Logger(SgaService.name);

  constructor(
    private prisma: PrismaService,
    private sgaAuthService: SgaAuthService,
    private readonly suriNotificacaoService: SuriNotificacaoService,
    @InjectQueue(BOLETO_VERIFICACAO_QUEUE as string)
    private readonly boletoVerificacaoQueue: Queue,
    private readonly associadoSincronizacao: AssociadoSincronizacaoService,
  ) {}

  /**
   * Busca o recorte do usuário usado nas consultas ao SGA: CPF limpo
   * (somente dígitos), base de origem e os campos cadastrais comparados
   * pela sincronização com o SGA (uma única leitura no banco).
   */
  private async getUserParaSga(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        cpf: true,
        baseOrigin: true,
        name: true,
        email: true,
        cep: true,
        address: true,
      },
    });
    if (!user || !user.cpf) {
      throw new NotFoundException('CPF não encontrado para o usuário');
    }
    return { ...user, cpf: user.cpf.replace(/\D/g, '') };
  }

  /**
   * Realiza chamada à API SGA da Hinova para buscar dados do associado.
   * Quando `baseOriginOverride` é fornecido, ele é usado diretamente,
   * evitando o relookup de CPF no banco que pode falhar por diferença de formatação.
   */
  private async fetchSgaAssociado(
    cpf: string,
    baseOriginOverride?: BaseOrigin,
  ) {
    const url = `${SGA_BASE_URL}/associado/buscar/${cpf}`;

    let baseOrigin: BaseOrigin = baseOriginOverride ?? TENANT.defaultBase;

    if (!baseOriginOverride) {
      // Fallback: tenta resolver baseOrigin pelo CPF no banco
      // Obs.: pode falhar se o CPF estiver armazenado com formatação diferente
      try {
        const user = await this.prisma.user.findFirst({ where: { cpf } });
        if (user?.baseOrigin) baseOrigin = user.baseOrigin;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'erro desconhecido';
        this.logger.warn(
          `Falha ao resolver baseOrigin por cpf=${cpf}: ${message}`,
        );
      }
    }

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
      // Leitura: /sga/associado e /sga/veiculos disparam esta mesma chamada na
      // abertura do app; requisições idênticas em voo compartilham a resposta.
      compartilharEmVoo: true,
    });
  }

  private async fetchSgaVeiculo(chassi: string) {
    const url = `${SGA_BASE_URL}/veiculo/buscar/${chassi}`;

    // try to determine baseOrigin from vehicle owner
    let baseOrigin: BaseOrigin = TENANT.defaultBase;
    try {
      const userVehicle = await this.prisma.userVehicle.findFirst({
        where: { chassi },
        select: { user: { select: { baseOrigin: true } } },
      });
      if (userVehicle?.user?.baseOrigin) {
        baseOrigin = userVehicle.user.baseOrigin;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(
        `Falha ao resolver baseOrigin por chassi=${chassi}: ${message}`,
      );
    }

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
      compartilharEmVoo: true,
    });
  }

  async consultarAssociado(userId: number) {
    const usuario = await this.getUserParaSga(userId);
    try {
      const response = await this.fetchSgaAssociado(
        usuario.cpf,
        usuario.baseOrigin ?? undefined,
      );
      if (response.status === 406) {
        return response.data;
      }
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }
      // Reaproveita o corpo já obtido para alinhar o cadastro local ao SGA,
      // em segundo plano: não bloqueia nem altera a resposta ao app.
      this.associadoSincronizacao.sincronizarEmSegundoPlano(
        usuario,
        response.data,
      );
      return response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException('Erro ao consultar SGA');
    }
  }

  async consultarVeiculosAssociado(userId: number) {
    const usuario = await this.getUserParaSga(userId);
    try {
      const response = await this.fetchSgaAssociado(
        usuario.cpf,
        usuario.baseOrigin ?? undefined,
      );
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }

      // Mesmo corpo do SGA de /sga/associado: alinha o cadastro local também
      // por esta rota, pois o app pode abrir consultando só os veículos.
      this.associadoSincronizacao.sincronizarEmSegundoPlano(
        usuario,
        response.data,
      );

      // Persistência local dos veículos
      const data = response.data as SgaAssociadoResponse | null | undefined;
      const veiculos = Array.isArray(data?.veiculos) ? data.veiculos : [];
      const now = new Date();
      const upsertedChassis = new Set<string>();

      // Upsert all vehicles
      for (const v of veiculos) {
        if (!v.chassi) continue; // skip invalid
        upsertedChassis.add(String(v.chassi));
        await this.prisma.userVehicle.upsert({
          where: {
            userId_chassi: {
              userId: userId,
              chassi: v.chassi,
            },
          },
          update: {
            plate: v.placa || null,
            externalVehicleCode: v.codigo_veiculo
              ? String(v.codigo_veiculo)
              : null,
            isActive: true,
            lastSyncAt: now,
          },
          create: {
            userId: userId,
            chassi: v.chassi,
            plate: v.placa || null,
            externalVehicleCode: v.codigo_veiculo
              ? String(v.codigo_veiculo)
              : null,
            isActive: true,
            lastSyncAt: now,
          },
        });
      }

      // Mark as inactive any vehicles not present in the latest sync
      await this.prisma.userVehicle.updateMany({
        where: {
          userId: userId,
          chassi: { notIn: Array.from(upsertedChassis) },
          isActive: true,
        },
        data: {
          isActive: false,
          lastSyncAt: now,
        },
      });

      // Retorna apenas o array de veículos (mantém resposta para frontend)
      return veiculos;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException(
        'Erro ao consultar veículos do associado',
      );
    }
  }

  async consultarVeiculoInfo(chassi: string) {
    const normalizedChassi = chassi?.trim();

    if (!normalizedChassi) {
      throw new BadRequestException('Chassi é obrigatório');
    }

    try {
      const response = await this.fetchSgaVeiculo(normalizedChassi);
      if (response.status >= 400) {
        return (
          response.data || {
            mensagem: 'Erro desconhecido',
            error: [response.statusText],
          }
        );
      }

      const veiculos = Array.isArray(response.data)
        ? response.data
        : response.data
          ? [response.data]
          : [];

      return veiculos.map((veiculo) => ({
        codigo_veiculo: veiculo?.codigo_veiculo ?? null,
        chassi: veiculo?.chassi ?? null,
        placa: veiculo?.placa ?? null,
        tipo: veiculo?.tipo ?? null,
        categoria: veiculo?.categoria ?? null,
        nome: veiculo?.nome ?? null,
      }));
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      throw new InternalServerErrorException(
        'Erro ao consultar veículo no SGA',
      );
    }
  }

  async setRevistoria(chassi: string, reinspectionRequired: boolean) {
    const normalizedChassi = chassi.trim();

    const result = await this.prisma.userVehicle.updateMany({
      where: {
        chassi: normalizedChassi,
      },
      data: {
        reinspectionRequired,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException(
        'Veículo não encontrado para o chassi informado',
      );
    }

    return;
  }

  private async fetchProdutosVinculadosVeiculo(
    placa: string,
    baseOrigin: BaseOrigin,
  ) {
    const url = `${SGA_BASE_URL}/produto-vinculado-veiculo/listar/${placa}`;

    return this.sgaAuthService.executeRequestWithAuth(baseOrigin, {
      method: 'GET',
      url,
      validateStatus: () => true,
      compartilharEmVoo: true,
    });
  }

  private async alterarSituacaoVeiculo(
    codigoSituacao: number,
    codigoVeiculo: string,
    baseOrigin: BaseOrigin,
  ) {
    const url = `${SGA_BASE_URL}/veiculo/alterar-situacao-para/${codigoSituacao}/${codigoVeiculo}`;

    const response = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      { method: 'GET', url, validateStatus: () => true },
    );

    if (response.status >= 400) {
      throw new InternalServerErrorException(
        `Erro ao alterar situação do veículo: ${JSON.stringify(response.data)}`,
      );
    }

    return response.data;
  }

  /**
   * Dados do associado usados no boleto de reativação, no poller e na Suri.
   * Lança erro tipado (instabilidade x definitivo) conforme a resposta do SGA.
   */
  async buscarDadosAssociadoParaBoleto(
    cpf: string,
    baseOrigin: BaseOrigin,
  ): Promise<DadosAssociadoBoleto> {
    let response: { status: number; data: unknown };
    try {
      response = await this.fetchSgaAssociado(cpf, baseOrigin);
    } catch (error) {
      throw erroDaExcecaoSga('associado/buscar', error);
    }

    if (response.status >= 400) {
      throw erroDaRespostaSga(
        'associado/buscar',
        response.status,
        response.data,
      );
    }

    const raw = Array.isArray(response.data)
      ? ((response.data[0] ?? {}) as Record<string, unknown>)
      : ((response.data ?? {}) as Record<string, unknown>);

    const codigoAssociado =
      raw.codigo_associado != null ? Number(raw.codigo_associado) : undefined;
    if (!codigoAssociado) {
      throw new BoletoReativacaoDefinitivoError(
        'associado/buscar: resposta sem codigo_associado',
        'associado/buscar',
        response.status,
      );
    }

    return {
      codigoAssociado,
      codigoRegional:
        raw.codigo_regional != null ? Number(raw.codigo_regional) : undefined,
      nome: typeof raw.nome === 'string' ? raw.nome : undefined,
      telefoneCelular:
        typeof raw.telefone_celular === 'string'
          ? raw.telefone_celular
          : undefined,
    };
  }

  private async buscarProdutosVeiculoParaBoleto(
    plate: string,
    baseOrigin: BaseOrigin,
  ): Promise<{
    valorTotalProdutosAtivo: number;
    taxaAdministrativa: string;
    codigoVeiculo?: string;
  }> {
    let response: { status: number; data: unknown };
    try {
      response = await this.fetchProdutosVinculadosVeiculo(plate, baseOrigin);
    } catch (error) {
      throw erroDaExcecaoSga('produto-vinculado-veiculo', error);
    }

    if (response.status >= 400) {
      throw erroDaRespostaSga(
        'produto-vinculado-veiculo',
        response.status,
        response.data,
      );
    }

    const raw = Array.isArray(response.data)
      ? ((response.data[0] ?? {}) as Record<string, unknown>)
      : ((response.data ?? {}) as Record<string, unknown>);

    return {
      valorTotalProdutosAtivo: Number(
        raw.valor_total_produtos_ativo_reais ?? 0,
      ),
      taxaAdministrativa: escalarParaString(raw.taxa_administrativa) ?? '0',
      codigoVeiculo: escalarParaString(raw.codigo_veiculo),
    };
  }

  /**
   * Cadastra o boleto de reativação no SGA e conclui o processo: persiste o
   * pagamento, coloca o veículo em situação 20, agenda o poller de pagamento
   * e manda o template Suri com o link.
   *
   * Erros são tipados: `BoletoReativacaoInstabilidadeError` (retry) ou
   * `BoletoReativacaoDefinitivoError` (não adianta repetir).
   */
  async criarBoletoReativacao(
    userVehicleId: number,
    plate: string,
    debugId?: string,
    opcoes?: { reinspectionId?: number },
  ): Promise<BoletoReativacaoCriado> {
    // 1. Resolve CPF e baseOrigin a partir do veículo
    const userVehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { user: { select: { cpf: true, baseOrigin: true } } },
    });

    if (!userVehicle?.user?.cpf) {
      throw new BoletoReativacaoDefinitivoError(
        'CPF não encontrado para o veículo',
        'dados-locais',
      );
    }

    const cpf = userVehicle.user.cpf.replace(/\D/g, '');
    const baseOrigin: BaseOrigin =
      (userVehicle.user.baseOrigin as BaseOrigin) ?? TENANT.defaultBase;

    // 2. Associado (codigo_associado, codigo_regional, nome, telefone)
    const associado = await this.buscarDadosAssociadoParaBoleto(
      cpf,
      baseOrigin,
    );

    // 3. Produtos vinculados ao veículo (valor, taxa, codigo_veiculo)
    const produtos = await this.buscarProdutosVeiculoParaBoleto(
      plate,
      baseOrigin,
    );

    // 4. Valor total (taxa_administrativa pode ser negativa)
    const totalValue =
      parseFloat(produtos.taxaAdministrativa) +
      produtos.valorTotalProdutosAtivo;
    const formattedValue = totalValue.toFixed(2).replace('.', ',');

    // 5. Datas
    const now = new Date();
    const mesReferente = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const vencimento = formatDateBR(tomorrow);

    // 6. Cadastrar boleto
    const boletoPayload = {
      codigo_associado: associado.codigoAssociado,
      codigo_regional: associado.codigoRegional,
      codigo_situacao: '2',
      mes_referente: mesReferente,
      link_boleto: true,
      codigo_tipo_boleto: CODIGO_TIPO_BOLETO_REATIVACAO,
      array_parcela: [{ valor: formattedValue, vencimento }],
      referencia: [
        {
          modulo: 'veiculo',
          codigo_modulo: produtos.codigoVeiculo,
          descricao: 'Boleto reativação app',
          valor: formattedValue,
        },
      ],
    };

    let boletoResponse: { status: number; data: unknown };
    try {
      boletoResponse = await this.sgaAuthService.executeRequestWithAuth(
        baseOrigin,
        {
          method: 'POST',
          url: `${SGA_BASE_URL}/boleto/cadastrar`,
          data: boletoPayload,
          headers: { 'Content-Type': 'application/json' },
          timeout: SGA_BOLETO_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
    } catch (error) {
      throw erroDaExcecaoSga('boleto/cadastrar', error);
    }

    if (boletoResponse.status >= 400) {
      throw erroDaRespostaSga(
        'boleto/cadastrar',
        boletoResponse.status,
        boletoResponse.data,
      );
    }

    // 7. nosso_numero, linha_digitavel e link_boleto (formatos conhecidos da Hinova)
    const boletoDados = normalizeBoletoCadastrado(boletoResponse.data)[0];
    if (!boletoDados) {
      this.logger.warn(
        `Dados do boleto ausentes em todos os formatos | userVehicleId=${userVehicleId} | rawBody=${JSON.stringify(boletoResponse.data)}`,
      );
    }

    const nossoNumero =
      boletoDados?.nosso_numero != null
        ? String(boletoDados.nosso_numero)
        : null;
    const linhaDigitavel =
      typeof boletoDados?.linha_digitavel === 'string'
        ? boletoDados.linha_digitavel
        : null;
    const linkBoleto =
      typeof boletoDados?.link_boleto === 'string'
        ? boletoDados.link_boleto
        : null;

    // 8. Persistir pagamento
    await this.registrarPagamentoBoleto({
      userVehicleId,
      reinspectionId: opcoes?.reinspectionId,
      nossoNumero,
      linhaDigitavel,
      linkBoleto,
      debugId,
    });

    // 9. Situação do veículo → 20 (aguardando reativação)
    if (produtos.codigoVeiculo) {
      try {
        await this.alterarSituacaoVeiculo(
          20,
          produtos.codigoVeiculo,
          baseOrigin,
        );
      } catch (alterarError) {
        this.logger.error(
          `Falha ao alterar situação do veículo para 20 | codigo_veiculo=${produtos.codigoVeiculo}`,
          alterarError instanceof Error ? alterarError.stack : undefined,
        );
      }
    }

    // 10. Poller de pagamento + 11. Suri
    const concluido = await this.concluirBoletoReativacao({
      userVehicleId,
      baseOrigin,
      nossoNumero,
      linkBoleto,
      codigoVeiculo: produtos.codigoVeiculo,
      associado,
      debugId,
    });

    return {
      nossoNumero,
      linhaDigitavel,
      linkBoleto,
      codigoVeiculo: produtos.codigoVeiculo ?? null,
      codigoAssociado: associado.codigoAssociado,
      pollerAgendado: concluido.pollerAgendado,
      suriEnviada: concluido.suriEnviada,
    };
  }

  /**
   * Grava/atualiza o `ReinspectionPayment` do boleto. Nunca lança: a falha
   * de persistência é logada e o fluxo segue (o boleto já existe no SGA).
   */
  async registrarPagamentoBoleto(params: {
    userVehicleId: number;
    reinspectionId?: number;
    nossoNumero: string | null;
    linhaDigitavel: string | null;
    linkBoleto: string | null;
    debugId?: string;
  }): Promise<void> {
    try {
      if (params.nossoNumero) {
        await this.prisma.reinspectionPayment.upsert({
          where: { nossoNumero: params.nossoNumero },
          update: {
            linhaDigitavel: params.linhaDigitavel,
            linkBoleto: params.linkBoleto,
            situacaoBoleto: 'CRIADO',
            pago: false,
            pagoEm: null,
            ...(params.reinspectionId
              ? { reinspectionId: params.reinspectionId }
              : {}),
          },
          create: {
            userVehicleId: params.userVehicleId,
            reinspectionId: params.reinspectionId ?? null,
            nossoNumero: params.nossoNumero,
            linhaDigitavel: params.linhaDigitavel,
            linkBoleto: params.linkBoleto,
            situacaoBoleto: 'CRIADO',
            boletoCriadoEm: new Date(),
            pago: false,
          },
        });
      } else {
        await this.prisma.reinspectionPayment.create({
          data: {
            userVehicleId: params.userVehicleId,
            reinspectionId: params.reinspectionId ?? null,
            linhaDigitavel: params.linhaDigitavel,
            linkBoleto: params.linkBoleto,
            situacaoBoleto: 'CRIADO',
            boletoCriadoEm: new Date(),
            pago: false,
          },
        });
      }
    } catch (paymentPersistError) {
      this.logger.error(
        debugLog(
          SgaService.name,
          'Falha ao persistir pagamento de revistoria (inicial)',
          params.debugId,
          {
            userVehicleId: params.userVehicleId,
            nossoNumero: params.nossoNumero ?? 'N/A',
            error:
              paymentPersistError instanceof Error
                ? paymentPersistError.message
                : String(paymentPersistError),
          },
        ),
      );
    }
  }

  /**
   * Etapas finais comuns ao boleto cadastrado pela API e ao boleto adotado
   * (já existente no SGA): agenda o poller de pagamento e envia o template
   * Suri com o link. Nunca lança.
   */
  async concluirBoletoReativacao(params: {
    userVehicleId: number;
    baseOrigin: BaseOrigin;
    nossoNumero: string | null;
    linkBoleto: string | null;
    codigoVeiculo?: string | null;
    associado: DadosAssociadoBoleto;
    debugId?: string;
  }): Promise<{ pollerAgendado: boolean; suriEnviada: boolean }> {
    let pollerAgendado = false;
    if (params.nossoNumero && params.codigoVeiculo) {
      try {
        await this.boletoVerificacaoQueue.add(
          JOB_VERIFICAR_BOLETO,
          {
            userVehicleId: params.userVehicleId,
            nosso_numero: Number(params.nossoNumero),
            codigo_veiculo: params.codigoVeiculo,
            codigo_associado: params.associado.codigoAssociado,
            baseOrigin: params.baseOrigin,
            nome: params.associado.nome,
            telefone_celular: params.associado.telefoneCelular,
            debugId: params.debugId,
          },
          {
            repeat: {
              every: INTERVALO_BASE_MS,
              endDate: prazoFinalPoller(getBoletoVerificacaoConfig()),
            },
            jobId: `${JOB_ID_PREFIXO_VERIFICACAO}${params.nossoNumero}`,
          },
        );
        pollerAgendado = true;
      } catch (queueError) {
        this.logger.error(
          debugLog(
            SgaService.name,
            'Falha ao agendar poller de verificação do boleto',
            params.debugId,
            {
              userVehicleId: params.userVehicleId,
              nossoNumero: params.nossoNumero,
              error:
                queueError instanceof Error
                  ? queueError.message
                  : String(queueError),
            },
          ),
        );
      }
    } else {
      this.logger.warn(
        debugLog(
          SgaService.name,
          'Poller de boleto não agendado: nosso_numero ou codigo_veiculo ausente',
          params.debugId,
          {
            userVehicleId: params.userVehicleId,
            nossoNumero: params.nossoNumero ?? 'N/A',
            codigoVeiculo: params.codigoVeiculo ?? 'N/A',
          },
        ),
      );
    }

    let suriEnviada = false;
    if (params.linkBoleto) {
      try {
        await this.suriNotificacaoService.enviarTemplate({
          nome: params.associado.nome ?? '',
          telefoneCelular: params.associado.telefoneCelular ?? '',
          templateId: process.env.suri_template_id,
          parametrosExtras: [params.linkBoleto],
        });
        suriEnviada = true;
      } catch (suriError) {
        this.logger.error(
          debugLog(
            SgaService.name,
            'Falha ao enviar notificação Suri',
            params.debugId,
            {
              userVehicleId: params.userVehicleId,
              error:
                suriError instanceof Error
                  ? suriError.message
                  : String(suriError),
            },
          ),
        );
      }
    } else {
      this.logger.warn(
        debugLog(
          SgaService.name,
          'link_boleto não encontrado; notificação Suri não enviada',
          params.debugId,
          {
            userVehicleId: params.userVehicleId,
            nossoNumero: params.nossoNumero ?? 'N/A',
          },
        ),
      );
    }

    return { pollerAgendado, suriEnviada };
  }
}

/** Converte número/string do SGA em string; objetos/nulos viram undefined. */
function escalarParaString(valor: unknown): string | undefined {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'bigint') {
    return String(valor);
  }
  return undefined;
}

/** `codigo_tipo_boleto` usado no cadastro do boleto de reativação. */
export const CODIGO_TIPO_BOLETO_REATIVACAO = 2;
/** Timeout do `boleto/cadastrar` (gera boleto e link no SGA). */
const SGA_BOLETO_TIMEOUT_MS = 60_000;

export interface DadosAssociadoBoleto {
  codigoAssociado: number;
  codigoRegional?: number;
  nome?: string;
  telefoneCelular?: string;
}

export interface BoletoReativacaoCriado {
  nossoNumero: string | null;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
  codigoVeiculo: string | null;
  codigoAssociado: number;
  pollerAgendado: boolean;
  suriEnviada: boolean;
}

type BoletoCadastradoItem = {
  nosso_numero?: number | string;
  linha_digitavel?: string;
  link_boleto?: string;
  [key: string]: unknown;
};

/**
 * Formatos conhecidos da resposta de `boleto/cadastrar`:
 * array direto, `{ dados_boleto_inserido: [...] }` ou `{ "0": {...}, mensagem }`.
 */
function normalizeBoletoCadastrado(input: unknown): BoletoCadastradoItem[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.filter(
      (item): item is BoletoCadastradoItem =>
        !!item && typeof item === 'object',
    );
  }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.dados_boleto_inserido)) {
      return record.dados_boleto_inserido.filter(
        (item): item is BoletoCadastradoItem =>
          !!item && typeof item === 'object',
      );
    }
    const numericKeyItems = Object.entries(record)
      .filter(
        ([key, value]) =>
          /^\d+$/.test(key) && !!value && typeof value === 'object',
      )
      .map(([, value]) => value as BoletoCadastradoItem);
    if (numericKeyItems.length > 0) return numericKeyItems;
  }
  return [];
}
