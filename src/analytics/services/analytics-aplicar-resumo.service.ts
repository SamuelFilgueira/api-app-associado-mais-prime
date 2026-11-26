import { Injectable } from '@nestjs/common';
import {
  DadosDoResumo,
  montarPlanoDeIngestao,
} from 'src/analytics/domain/agregados-diarios';
import {
  AnalyticsIngestaoRepository,
  ResultadoDaIngestao,
} from 'src/analytics/repositories/analytics-ingestao.repository';

/**
 * Aplica um summary já sanitizado (o payload do job `process-summary`): a
 * regra do que entra em cada tabela é do domínio
 * (`montarPlanoDeIngestao`); a gravação, numa transação só, é do
 * repositório.
 *
 * Idempotente pelo `payloadHash`: aplicar o mesmo summary de novo devolve
 * `DESCARTADO` sem tocar nos agregados.
 */
@Injectable()
export class AnalyticsAplicarResumoService {
  constructor(private readonly ingestao: AnalyticsIngestaoRepository) {}

  aplicar(dados: DadosDoResumo): Promise<ResultadoDaIngestao> {
    return this.ingestao.aplicar(montarPlanoDeIngestao(dados));
  }
}
