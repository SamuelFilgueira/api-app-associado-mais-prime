import { Provider, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/database/prisma.service';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { MailService } from 'src/infra/mail/mail.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { ReinspectionController } from 'src/reinspection/controllers/reinspection.controller';
import { ReinspectionModule } from 'src/reinspection/reinspection.module';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';

/**
 * O que o módulo recebe de fora: módulos globais (`DatabaseModule`,
 * `InfraModule`, `ConsistenciaModule`) e os que ele importa (`HinovaModule`,
 * `SgaModule`). Qualquer outra dependência tem de estar em `providers`.
 */
const DE_FORA = new Set<unknown>([
  PrismaService,
  MailService,
  FileUploadService,
  TravaService,
  IdempotenciaService,
  SgaAuthService,
  BoletoReativacaoService,
]);

describe('ReinspectionModule — fiação', () => {
  it('instancia controllers e casos de uso só com os providers do módulo e as dependências externas conhecidas', async () => {
    const providers = Reflect.getMetadata(
      'providers',
      ReinspectionModule,
    ) as Provider[];
    const controllers = Reflect.getMetadata(
      'controllers',
      ReinspectionModule,
    ) as Type[];

    const modulo = await Test.createTestingModule({ providers, controllers })
      .useMocker((token) => {
        if (DE_FORA.has(token)) return {};
        const nome =
          typeof token === 'function' ? token.name : String(token as string);
        throw new Error(
          `Dependência não registrada no ReinspectionModule: ${nome}`,
        );
      })
      .compile();

    expect(modulo.get(ReinspectionController)).toBeInstanceOf(
      ReinspectionController,
    );
    expect(modulo.get(ReinspectionService)).toBeInstanceOf(ReinspectionService);
    expect(modulo.get(ReinspectionHinovaService)).toBeInstanceOf(
      ReinspectionHinovaService,
    );
  });
});
