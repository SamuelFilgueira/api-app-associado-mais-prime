import { NotFoundException } from '@nestjs/common';
import { PushDisparoRepository } from 'src/notifications/repositories/push-disparo.repository';
import { PushDisparoConsultaService } from 'src/notifications/services/push-disparo-consulta.service';

function montar(
  parcial: Partial<Record<keyof PushDisparoRepository, jest.Mock>>,
) {
  const repo = {
    buscarDisparo: jest.fn().mockResolvedValue(null),
    contarPorEstado: jest.fn().mockResolvedValue({}),
    cpfsSemEnvio: jest.fn().mockResolvedValue([]),
    ...parcial,
  };
  return {
    repo,
    service: new PushDisparoConsultaService(
      repo as unknown as PushDisparoRepository,
    ),
  };
}

const disparo = (estado: string) => ({
  id: 7,
  tipo: 'SITUACAO_CADASTRO',
  estado,
  totalDestinatarios: 5,
  criadoEm: new Date('2026-11-26T12:00:00Z'),
  concluidoEm: estado === 'CONCLUIDO' ? new Date('2026-11-26T12:01:00Z') : null,
});

describe('PushDisparoConsultaService', () => {
  it('disparo inexistente → 404', async () => {
    const { service } = montar({});

    await expect(service.consultar(99)).rejects.toThrow(NotFoundException);
  });

  it('disparo concluído: contagens por estado e os CPFs que ficaram sem push', async () => {
    const { service, repo } = montar({
      buscarDisparo: jest.fn().mockResolvedValue(disparo('CONCLUIDO')),
      contarPorEstado: jest
        .fn()
        .mockResolvedValue({ ENVIADA: 2, ENTREGUE: 1, RECUSADA: 1, FALHA: 1 }),
      cpfsSemEnvio: jest.fn().mockResolvedValue(['11111111111', '22222222222']),
    });

    const resposta = await service.consultar(7);

    expect(resposta).toEqual({
      disparoId: 7,
      tipo: 'SITUACAO_CADASTRO',
      estado: 'CONCLUIDO',
      emAndamento: false,
      totalDestinatarios: 5,
      criadoEm: new Date('2026-11-26T12:00:00Z'),
      concluidoEm: new Date('2026-11-26T12:01:00Z'),
      entregas: {
        pendentes: 0,
        enviadas: 3,
        entregues: 1,
        recusadas: 1,
        falhas: 1,
      },
      cpfsComFalhaEnvio: ['11111111111', '22222222222'],
      cpfsComFalhaEnvioTruncado: false,
    });
    expect(repo.cpfsSemEnvio).toHaveBeenCalledWith(7, 1_000);
  });

  it('ainda enviando: `emAndamento` e pendentes; lista cortada avisa que há mais', async () => {
    const { service } = montar({
      buscarDisparo: jest.fn().mockResolvedValue(disparo('ENVIANDO')),
      contarPorEstado: jest.fn().mockResolvedValue({ PENDENTE: 3, FALHA: 2 }),
      cpfsSemEnvio: jest.fn().mockResolvedValue(['11111111111']),
    });

    const resposta = await service.consultar(7);

    expect(resposta.emAndamento).toBe(true);
    expect(resposta.entregas.pendentes).toBe(3);
    expect(resposta.cpfsComFalhaEnvioTruncado).toBe(true);
  });
});
