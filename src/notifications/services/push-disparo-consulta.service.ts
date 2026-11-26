import { Injectable, NotFoundException } from '@nestjs/common';
import { PushDisparoRepository } from 'src/notifications/repositories/push-disparo.repository';

/** Teto da lista de CPFs devolvida pela consulta. */
export const MAX_CPFS_NA_CONSULTA = 1_000;

/**
 * Consulta de um disparo de push em massa (marketing ou planilha).
 *
 * O envio é assíncrono: a rota que cria o disparo responde com o que se sabe
 * na hora (destinatários selecionados). O resultado real — quantos foram
 * aceitos, recusados e quais CPFs ficaram sem push — sai daqui, pelo
 * `disparoId` devolvido na criação.
 */
@Injectable()
export class PushDisparoConsultaService {
  constructor(private readonly repo: PushDisparoRepository) {}

  async consultar(disparoId: number) {
    const disparo = await this.repo.buscarDisparo(disparoId);
    if (!disparo) throw new NotFoundException('Disparo não encontrado');

    const [porEstado, cpfsComFalhaEnvio] = await Promise.all([
      this.repo.contarPorEstado(disparoId),
      this.repo.cpfsSemEnvio(disparoId, MAX_CPFS_NA_CONSULTA),
    ]);
    const semEnvio = (porEstado.RECUSADA ?? 0) + (porEstado.FALHA ?? 0);

    return {
      disparoId: disparo.id,
      tipo: disparo.tipo,
      estado: disparo.estado,
      /** `true` enquanto ainda há lote por enviar. */
      emAndamento: disparo.estado === 'CRIADO' || disparo.estado === 'ENVIANDO',
      totalDestinatarios: disparo.totalDestinatarios,
      criadoEm: disparo.criadoEm,
      concluidoEm: disparo.concluidoEm,
      /** Contagem atual das entregas por estado (muda enquanto envia). */
      entregas: {
        pendentes: porEstado.PENDENTE ?? 0,
        enviadas: (porEstado.ENVIADA ?? 0) + (porEstado.ENTREGUE ?? 0),
        entregues: porEstado.ENTREGUE ?? 0,
        recusadas: porEstado.RECUSADA ?? 0,
        falhas: porEstado.FALHA ?? 0,
      },
      cpfsComFalhaEnvio,
      /** `true` se há mais CPFs sem envio do que os listados. */
      cpfsComFalhaEnvioTruncado: semEnvio > cpfsComFalhaEnvio.length,
    };
  }
}
