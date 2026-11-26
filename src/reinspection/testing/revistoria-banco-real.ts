import { ReinspectionPhotoStatus, ReinspectionStatus } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

/**
 * Apoio aos testes de INTEGRAÇÃO da revistoria (banco real). Toda linha
 * criada pendura num usuário cujo e-mail começa com `MARCA`; a limpeza apaga
 * só esses usuários (veículos, revistorias, fotos e envios vão por cascata).
 */
export const MARCA_REVISTORIA = 'it-revistoria-';

export class RevistoriaBancoReal {
  private readonly marca = `${MARCA_REVISTORIA}${process.pid}-${Date.now()}`;
  private readonly semente = Date.now() % 90_000;
  private sequencia = 0;
  readonly usuarios: number[] = [];

  constructor(private readonly prisma: PrismaService) {}

  /** Associado + veículo. */
  async veiculo(baseOrigin: string | null = 'MAIS_PRIME') {
    const n = ++this.sequencia;
    // CPF único por execução: 7 + 5 dígitos do processo + 5 da sequência.
    const cpf = `7${String(process.pid % 100_000).padStart(5, '0')}${String(
      this.semente + n,
    ).padStart(5, '0')}`;
    const usuario = await this.prisma.user.create({
      data: {
        name: `${this.marca}-${n}`,
        cpf,
        email: `${this.marca}-${n}@teste.local`,
        passwordHash: 'x',
        baseOrigin,
      },
    });
    this.usuarios.push(usuario.id);

    const veiculo = await this.prisma.userVehicle.create({
      data: {
        userId: usuario.id,
        chassi: `IT${process.pid}${n}`.slice(0, 17),
        plate: `IT${n}`.slice(0, 7),
      },
    });
    return { userId: usuario.id, userVehicleId: veiculo.id };
  }

  /** Veículo com uma revistoria no status pedido e fotos nos status dados. */
  async revistoria(
    status: ReinspectionStatus,
    fotos: ReinspectionPhotoStatus[] = [],
    baseOrigin: string | null = 'MAIS_PRIME',
  ) {
    const dono = await this.veiculo(baseOrigin);
    const revistoria = await this.prisma.reinspection.create({
      data: {
        userVehicleId: dono.userVehicleId,
        vehicleType: 'VEICULOS_LEVES',
        status,
      },
    });

    const fotoIds: number[] = [];
    for (const [i, statusDaFoto] of fotos.entries()) {
      const foto = await this.prisma.reinspectionPhoto.create({
        data: {
          reinspectionId: revistoria.id,
          nomeArquivo: `ordem_${i + 1}.jpg`,
          url: `uploads/reinspection-photos/${this.marca}-${revistoria.id}-${i}.jpg`,
          status: statusDaFoto,
        },
      });
      fotoIds.push(foto.id);
    }
    return { ...dono, reinspectionId: revistoria.id, fotoIds };
  }

  status(reinspectionId: number) {
    return this.prisma.reinspection
      .findUniqueOrThrow({
        where: { id: reinspectionId },
        select: { status: true },
      })
      .then((r) => r.status);
  }

  async temFotoReprovada(reinspectionId: number): Promise<boolean> {
    const total = await this.prisma.reinspectionPhoto.count({
      where: { reinspectionId, status: 'REPROVADA' },
    });
    return total > 0;
  }

  /** Apaga o que esta execução criou. */
  async limpar(): Promise<void> {
    if (this.usuarios.length === 0) return;
    await this.prisma.chaveDeIdempotencia.deleteMany({
      where: { userId: { in: this.usuarios } },
    });
    await this.prisma.user.deleteMany({
      where: { id: { in: this.usuarios } },
    });
  }
}
