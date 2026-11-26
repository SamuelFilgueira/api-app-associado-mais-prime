import { BadRequestException, Injectable } from '@nestjs/common';
import { BaseOrigin, TENANT } from 'src/config/tenant.config';
import { problemaNoPeriodoDeHistorico } from 'src/rastreamento/domain/periodo-historico';
import { ProvedorLogica } from 'src/rastreamento/logica/services/logica-provedor';
import {
  LogicaRastreamentoService,
  UltimaPosicaoLogicaResponse,
} from 'src/rastreamento/logica/services/rastreamento.logica';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import { garantirRastreamentoLiberado } from 'src/rastreamento/services/rastreamento-liberado';
import { HistoricoRotasResponseDto } from 'src/rastreamento/softruck/dto/historico-response.dto';
import { UltimaPosicaoSoftruckResponse } from 'src/rastreamento/softruck/dto/ultima-posicao.dto';
import { HistoricoSoftruckService } from 'src/rastreamento/softruck/services/historico-softruck.service';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { SoftruckCredenciais } from 'src/rastreamento/softruck/services/softruck-credenciais';

/**
 * Rotas que falam com UM provedor específico (posição direta, histórico da
 * Softruck, renovação do token da M7). Cada uma resolve só a credencial do
 * provedor que usa — uma base sem Lógica ou sem Softruck continua atendendo
 * as rotas da M7.
 */
@Injectable()
export class ConsultasPorProvedorService {
  constructor(
    private readonly veiculos: VeiculoRastreamentoRepository,
    private readonly m7: RastreamentoM7,
    private readonly logica: LogicaRastreamentoService,
    private readonly provedorLogica: ProvedorLogica,
    private readonly softruck: RastreamentoSoftruck,
    private readonly softruckCredenciais: SoftruckCredenciais,
    private readonly historicoSoftruck: HistoricoSoftruckService,
  ) {}

  async ultimaPosicaoM7(cnpj: string, chassi: string, baseOrigin: BaseOrigin) {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    return this.m7.ultimaPosicaoM7(cnpj, chassi, baseOrigin);
  }

  /**
   * Sem `token`, a credencial da Lógica é resolvida aqui pela base do
   * contexto (é o caminho da rota do app).
   */
  async ultimaPosicaoLogica(
    chassi: string,
    token?: string,
    context?: { baseOrigin?: BaseOrigin; tokenKey?: string },
  ): Promise<UltimaPosicaoLogicaResponse> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    if (!token && context?.baseOrigin) {
      const credencial = this.provedorLogica.credencial(context.baseOrigin);
      return this.logica.ultimaPosicao(chassi, credencial.token, {
        baseOrigin: context.baseOrigin,
        tokenKey: credencial.tokenKey,
      });
    }
    return this.logica.ultimaPosicao(chassi, token, context);
  }

  async ultimaPosicaoSoftruck(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey?: string,
    tokenOverride?: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    return this.softruck.ultimaPosicaoSoftruck(
      chassi,
      baseOrigin,
      publicKey ?? this.softruckCredenciais.chavePublica(baseOrigin),
      tokenOverride,
    );
  }

  /** PDF de histórico de trajetórias via API Softruck. */
  async relatorioHistoricoSoftruckPdf(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey?: string,
  ): Promise<Buffer> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    const periodo = this.periodoValidado(chassi, dataInicial, dataFinal);
    return this.historicoSoftruck.gerarRelatorioPdf(
      periodo.chassi,
      periodo.dataInicial,
      periodo.dataFinal,
      baseOrigin,
      publicKey ?? this.softruckCredenciais.chavePublica(baseOrigin),
    );
  }

  /** Rotas detalhadas em GeoJSON para o período via API Softruck. */
  async rotasHistoricoSoftruck(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
    baseOrigin: BaseOrigin,
    publicKey?: string,
  ): Promise<HistoricoRotasResponseDto> {
    await garantirRastreamentoLiberado(this.veiculos, chassi);
    const periodo = this.periodoValidado(chassi, dataInicial, dataFinal);
    return this.historicoSoftruck.obterRotas(
      periodo.chassi,
      periodo.dataInicial,
      periodo.dataFinal,
      baseOrigin,
      publicKey ?? this.softruckCredenciais.chavePublica(baseOrigin),
    );
  }

  /**
   * Renova o token M7 de todas as bases configuradas.
   *
   * O retorno é um objeto com uma chave por base (ex.:
   * `{ MAIS_PRIME: ..., MAIS_PRIME_RS: ... }`), derivado de
   * `TENANT.baseNames`. Cada base informa se renovou e até quando o token
   * vale; o token em si não é devolvido (credencial de vendor não sai da API).
   */
  async renovarTokenM7(): Promise<Record<string, unknown>> {
    const bases = TENANT.baseNames;
    const resultados = await Promise.allSettled(
      bases.map((base) => this.m7.renovarToken(base)),
    );

    return bases.reduce<Record<string, unknown>>((acc, base, index) => {
      const resultado = resultados[index];
      acc[base] =
        resultado.status === 'fulfilled'
          ? { renovado: true, expires_in: resultado.value.expires_in }
          : { renovado: false, erro: 'Falha ao renovar o token' };
      return acc;
    }, {});
  }

  private periodoValidado(
    chassi: string,
    dataInicial: string,
    dataFinal: string,
  ): { chassi: string; dataInicial: string; dataFinal: string } {
    const periodo = {
      chassi: chassi?.trim(),
      dataInicial: dataInicial?.trim(),
      dataFinal: dataFinal?.trim(),
    };
    const problema = problemaNoPeriodoDeHistorico(
      periodo.chassi,
      periodo.dataInicial,
      periodo.dataFinal,
    );
    if (problema) throw new BadRequestException(problema);
    return periodo;
  }
}
