import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { BaseContextService } from 'src/shared/base-context.service';
import { TokenResolverService } from 'src/shared/token-resolver.service';
import { HistoricoQueryDto } from '../dto/historico-query.dto';
import { HistoricoResumoResponseDto } from '../dto/historico-resumo-response.dto';
import { HistoricoResumoService } from '../services/historico-resumo.service';

/**
 * Controller do endpoint de histórico em formato resumo (textual, sem geometria).
 *
 * URL: GET /rastreamento/softruck/historico/resumo
 *
 * Diferenças em relação ao endpoint /rotas:
 * - Não chama /geom — apenas /by-keys
 * - Retorna dados agrupados por data com `enterpriseId` exposto por dia
 * - O frontend pode usar acc + enterpriseId para obter o mapa de cada dia via /geom
 */
@Controller('rastreamento/softruck/historico')
export class HistoricoResumoController {
  constructor(
    private readonly resumoService: HistoricoResumoService,
    private readonly baseContextService: BaseContextService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  /**
   * Retorna o histórico de trajetórias do veículo agrupado por data,
   * sem pontos de geolocalização (apenas metadados textuais).
   *
   * @query chassi - Chassi do veículo (obrigatório)
   * @query dataInicial - Data inicial no formato YYYY-MM-DD (obrigatório)
   * @query dataFinal - Data final no formato YYYY-MM-DD (obrigatório, máx. 31 dias após dataInicial)
   *
   * @returns {@link HistoricoResumoResponseDto} com `vehicle`, `period`, `summary` e `dias[]`
   *
   * Cada item de `dias[]` contém `acc` e `enterpriseId`, que permitem ao frontend
   * buscar os detalhes de mapa via `/rastreamento/historico/softruck/rotas` ou diretamente via /geom.
   */
  @UseGuards(JwtAuthGuard)
  @Get('resumo')
  async obterResumo(
    @Query() query: HistoricoQueryDto,
  ): Promise<HistoricoResumoResponseDto> {
    const baseOrigin = this.baseContextService.getBaseOrigin();
    const softruckPublicKey =
      this.tokenResolver.resolveSoftruckPublicKey(baseOrigin);

    return this.resumoService.obterResumo(
      query.chassi,
      query.dataInicial,
      query.dataFinal,
      baseOrigin,
      softruckPublicKey,
    );
  }
}
