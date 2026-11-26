import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';

describe('AnalyticsModule — composição', () => {
  const metadado = <T>(chave: string) =>
    (Reflect.getMetadata(chave, AnalyticsModule) ?? []) as T[];

  it('não registra a fila de novo: a de analytics é a do QueueModule, com as opções padrão', () => {
    // Um `BullModule.registerQueue` aqui criaria uma segunda instância da
    // fila, sem `defaultJobOptions`, e o `ProdutorDeFilas` (que resolve o
    // token fora do módulo) passaria a usá-la: jobs sem retry nem retenção.
    const registrosDeFila = metadado<unknown>('imports').filter(
      (importado) => (importado as DynamicModule)?.module === BullModule,
    );

    expect(registrosDeFila).toEqual([]);
  });

  it('exporta o serviço de expurgo da jornada, para a rotina de manutenção', () => {
    expect(metadado('exports')).toContain(AnalyticsJornadaExpurgoService);
  });
});
