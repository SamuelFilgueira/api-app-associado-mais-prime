import { Injectable } from '@nestjs/common';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { DadosAssociadoBoleto } from 'src/sga/domain/boleto-sga.parser';
import {
  BoletoCriacaoService,
  BoletoReativacaoCriado,
  ConclusaoDoBoleto,
  RegistroDoBoleto,
} from 'src/sga/services/boleto-criacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { SgaConsultaService } from 'src/sga/services/sga-consulta.service';
import { SgaVeiculoInfoService } from 'src/sga/services/sga-veiculo-info.service';

export {
  removerVeiculosInativos,
  veiculoInativoNoSga,
} from 'src/sga/domain/veiculo-sga';
export type { DadosAssociadoBoleto } from 'src/sga/domain/boleto-sga.parser';
export type { BoletoReativacaoCriado } from 'src/sga/services/boleto-criacao.service';

/**
 * Fachada do módulo SGA: a API pública que controllers e outros módulos
 * sempre usaram. Não tem regra — só delega:
 *
 *  - consultas do app: associado e veículos → `SgaConsultaService`;
 *    veículo por chassi e marca de revistoria → `SgaVeiculoInfoService`;
 *  - boleto de reativação (cadastro, gravação, conclusão) →
 *    `BoletoCriacaoService` e `SgaBoletoClient`.
 */
@Injectable()
export class SgaService {
  constructor(
    private readonly consulta: SgaConsultaService,
    private readonly veiculoInfo: SgaVeiculoInfoService,
    private readonly boletoCriacao: BoletoCriacaoService,
    private readonly boletoClient: SgaBoletoClient,
  ) {}

  consultarAssociado(userId: number) {
    return this.consulta.consultarAssociado(userId);
  }

  consultarVeiculosAssociado(userId: number) {
    return this.consulta.consultarVeiculosAssociado(userId);
  }

  consultarVeiculoInfo(chassi: string, baseOrigin?: BaseOrigin | null) {
    return this.veiculoInfo.consultarVeiculoInfo(chassi, baseOrigin);
  }

  setRevistoria(chassi: string, reinspectionRequired: boolean) {
    return this.veiculoInfo.setRevistoria(chassi, reinspectionRequired);
  }

  buscarDadosAssociadoParaBoleto(
    cpf: string,
    baseOrigin: BaseOrigin,
  ): Promise<DadosAssociadoBoleto> {
    return this.boletoClient.buscarDadosAssociadoParaBoleto(cpf, baseOrigin);
  }

  criarBoletoReativacao(
    userVehicleId: number,
    plate: string,
    debugId?: string,
    opcoes?: { reinspectionId?: number },
  ): Promise<BoletoReativacaoCriado> {
    return this.boletoCriacao.criarBoletoReativacao(
      userVehicleId,
      plate,
      debugId,
      opcoes,
    );
  }

  registrarPagamentoBoleto(params: RegistroDoBoleto): Promise<void> {
    return this.boletoCriacao.registrarPagamentoBoleto(params);
  }

  concluirBoletoReativacao(
    params: ConclusaoDoBoleto,
  ): Promise<{ pollerAgendado: boolean; suriEnviada: boolean }> {
    return this.boletoCriacao.concluirBoletoReativacao(params);
  }
}
