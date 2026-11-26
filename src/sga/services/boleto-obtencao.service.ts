import { Injectable, Logger } from '@nestjs/common';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import {
  BoletoPronto,
  TentativaDeBoleto,
} from 'src/sga/domain/boleto-resultado';
import { BoletoReativacaoDefinitivoError } from 'src/sga/errors/boleto-reativacao.error';
import { logDoBoleto } from 'src/sga/helpers/boleto-log.helper';
import { BoletoAdocaoService } from 'src/sga/services/boleto-adocao.service';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';

/**
 * Obtém o boleto de reativação de uma tentativa que JÁ TEM o lease da
 * revistoria. Três caminhos, nesta ordem — o cadastro é sempre o último:
 *
 * 1. retomar: a API já cadastrou um boleto para a revistoria (o
 *    `nosso_numero` está gravado nela) e só a gravação local ficou para trás;
 * 2. adotar: já existe um boleto de reativação no SGA — criado à mão, ou por
 *    uma tentativa cuja resposta se perdeu;
 * 3. cadastrar pela API.
 *
 * Lança erro tipado (instabilidade x definitivo) ou cru; quem classifica e
 * grava o desfecho é o `BoletoDesfechoService`.
 */
@Injectable()
export class BoletoObtencaoService {
  private readonly logger = new Logger(BoletoObtencaoService.name);

  constructor(
    private readonly adocao: BoletoAdocaoService,
    private readonly criacao: BoletoCriacaoService,
  ) {}

  async obter(tentativa: TentativaDeBoleto): Promise<BoletoPronto> {
    const { revistoria, debugId, agora } = tentativa;
    const veiculo = revistoria.userVehicle;

    // Base do dono do veículo. Sem base válida não há boleto: nunca usa a
    // credencial (nem a regra) da base padrão do deploy.
    const base = exigirBase(
      veiculo.user?.baseOrigin,
      'boleto de reativação (base do dono do veículo)',
    );

    // Validações locais: não mudam com retry.
    if (!veiculo.plate) {
      throw new BoletoReativacaoDefinitivoError(
        'Placa não cadastrada para o veículo',
        'dados-locais',
      );
    }
    const cpf = veiculo.user?.cpf?.replace(/\D/g, '');
    if (!cpf) {
      throw new BoletoReativacaoDefinitivoError(
        'CPF não encontrado para o veículo',
        'dados-locais',
      );
    }

    const alvo = {
      reinspectionId: revistoria.id,
      userVehicleId: veiculo.id,
      base,
      cpf,
      debugId,
    };
    const codigoVeiculo =
      revistoria.codigoVeiculo != null
        ? String(revistoria.codigoVeiculo)
        : null;

    // 1) Retomar. Cadastrar de novo duplicaria o boleto.
    if (revistoria.boletoNossoNumero) {
      const nossoNumero = revistoria.boletoNossoNumero;
      this.log('warn', tentativa, 'Retomando boleto já cadastrado', {
        nossoNumero,
      });
      const retomado = await this.adocao.retomar(
        alvo,
        nossoNumero,
        { codigoVeiculo, plate: veiculo.plate },
        agora,
      );
      return {
        nossoNumero,
        linkBoleto: retomado.linkBoleto,
        suriEnviada: retomado.suriEnviada,
        adotado: revistoria.boletoOrigem === 'ADOTADO_SGA',
      };
    }

    // 2) Adotar. Sem o código do veículo na revistoria não há como listar
    // os boletos dele: segue direto para o cadastro.
    const existente = codigoVeiculo
      ? await this.adocao.localizar(alvo, codigoVeiculo, agora)
      : null;
    if (existente) {
      this.log(
        'warn',
        tentativa,
        'Boleto de reativação já existia no SGA; adotando',
        {
          nossoNumero: existente.nossoNumero,
          criterio: existente.criterio,
          tentativa: tentativa.numero,
        },
      );
      const adotado = await this.adocao.adotar(alvo, existente, codigoVeiculo);
      return {
        nossoNumero: existente.nossoNumero,
        linkBoleto: existente.linkBoleto,
        suriEnviada: adotado.suriEnviada,
        adotado: true,
      };
    }

    // 3) Cadastrar.
    const criado = await this.criacao.criarBoletoReativacao(
      veiculo.id,
      veiculo.plate,
      debugId,
      { reinspectionId: revistoria.id },
    );
    return {
      nossoNumero: criado.nossoNumero,
      linkBoleto: criado.linkBoleto,
      suriEnviada: criado.suriEnviada,
      adotado: false,
      pendencia: criado.pendencia,
    };
  }

  private log(
    nivel: 'log' | 'warn',
    tentativa: TentativaDeBoleto,
    mensagem: string,
    meta: Record<string, unknown>,
  ): void {
    logDoBoleto(
      this.logger,
      BoletoObtencaoService.name,
      nivel,
      {
        reinspectionId: tentativa.revistoria.id,
        baseOrigin: tentativa.revistoria.userVehicle.user?.baseOrigin,
        origem: tentativa.origem,
        debugId: tentativa.debugId,
      },
      mensagem,
      meta,
    );
  }
}
