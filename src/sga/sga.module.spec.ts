import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { MailService } from 'src/infra/mail/mail.service';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import {
  BOLETO_REATIVACAO_RETRY_QUEUE,
  BOLETO_VERIFICACAO_QUEUE,
} from 'src/queue/filas';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { BoletoModule } from 'src/sga/boleto/boleto.module';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';
import { BoletoReativacaoRetryProcessor } from 'src/sga/processors/boleto-reativacao-retry.processor';
import { BoletoVerificacaoProcessor } from 'src/sga/processors/boleto-verificacao.processor';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import { SgaService } from 'src/sga/services/sga.service';
import { SgaModule } from 'src/sga/sga.module';

const outbox = { registrarDestino: jest.fn(), registrar: jest.fn() };
const fila = () => ({
  upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  getJobSchedulers: jest.fn().mockResolvedValue([]),
});

/** O que os módulos globais da aplicação entregam ao módulo SGA. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: MailService, useValue: {} },
    { provide: CacheService, useValue: {} },
    { provide: OutboxService, useValue: outbox },
    { provide: ProdutorDeFilas, useValue: {} },
    { provide: FilaDeMortosService, useValue: {} },
    { provide: getQueueToken(BOLETO_VERIFICACAO_QUEUE), useValue: fila() },
    {
      provide: getQueueToken(BOLETO_REATIVACAO_RETRY_QUEUE),
      useValue: fila(),
    },
  ],
  exports: [
    PrismaService,
    MailService,
    CacheService,
    OutboxService,
    ProdutorDeFilas,
    FilaDeMortosService,
    getQueueToken(BOLETO_VERIFICACAO_QUEUE),
    getQueueToken(BOLETO_REATIVACAO_RETRY_QUEUE),
  ],
})
class GlobaisDeTeste {}

/**
 * O módulo sobe: toda dependência dos casos de uso e dos processors está
 * registrada. (Os specs dos casos de uso montam as classes com `new`, então
 * um provider esquecido no módulo só apareceria no boot da aplicação.)
 */
describe('SgaModule (injeção de dependências)', () => {
  let modulo: TestingModule;

  beforeAll(async () => {
    modulo = await Test.createTestingModule({
      imports: [GlobaisDeTeste, SgaModule, BoletoModule],
    })
      .overrideProvider(SgaAuthService)
      .useValue({})
      .overrideProvider(HinovaClient)
      .useValue({})
      .compile();
    await modulo.init();
  });

  afterAll(async () => {
    await modulo.close();
  });

  it('resolve as fachadas exportadas e o service de boletos do app', () => {
    expect(modulo.get(SgaService)).toBeInstanceOf(SgaService);
    expect(modulo.get(BoletoReativacaoService)).toBeInstanceOf(
      BoletoReativacaoService,
    );
    expect(modulo.get(BoletoService, { strict: false })).toBeInstanceOf(
      BoletoService,
    );
  });

  it('resolve os processors (papel `all`/`worker`)', () => {
    expect(modulo.get(BoletoVerificacaoProcessor)).toBeInstanceOf(
      BoletoVerificacaoProcessor,
    );
    expect(modulo.get(BoletoReativacaoRetryProcessor)).toBeInstanceOf(
      BoletoReativacaoRetryProcessor,
    );
  });

  it('registra no boot o destino do evento boleto.pago no outbox', () => {
    expect(outbox.registrarDestino).toHaveBeenCalledWith('boleto.pago', {
      fila: BOLETO_VERIFICACAO_QUEUE,
      job: 'avisar-boleto-pago',
    });
  });

  it('o boot dos processors garante um agendador por varredura', () => {
    const verificacao = modulo.get<{ upsertJobScheduler: jest.Mock }>(
      getQueueToken(BOLETO_VERIFICACAO_QUEUE),
      { strict: false },
    );
    const retry = modulo.get<{ upsertJobScheduler: jest.Mock }>(
      getQueueToken(BOLETO_REATIVACAO_RETRY_QUEUE),
      { strict: false },
    );

    expect(verificacao.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(retry.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });
});
