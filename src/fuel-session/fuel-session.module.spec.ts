/* eslint-disable @typescript-eslint/no-require-imports -- o módulo precisa ser reavaliado a cada caso (o papel é lido na importação), o que só o `require` depois de `jest.resetModules()` faz */
import type { Provider } from '@nestjs/common';

type AppConfigModulo = typeof import('src/config/app.config');
type ModuloFuel = typeof import('src/fuel-session/fuel-session.module');
type ProcessorFuel =
  typeof import('src/fuel-session/processors/fuel-economy.processor');
type ServiceFuel =
  typeof import('src/fuel-session/services/fuel-session.service');
type NestTesting = typeof import('@nestjs/testing');

/**
 * Papel do processo (`APP_ROLE`): o `@Processor` só entra na lista de
 * providers — e portanto só é instanciado pelo Nest — quando o processo
 * exerce o papel `worker`. Na `api` (e no `pdf`) o módulo só produz jobs.
 *
 * O papel é lido quando o módulo é importado (`paraPapel` roda dentro do
 * `@Module`), então cada caso reavalia os arquivos com `jest.resetModules()`.
 */
describe('FuelSessionModule — papel do processo (APP_ROLE)', () => {
  const papelOriginal = process.env.APP_ROLE;

  const definirPapel = (papel: string | undefined) => {
    if (papel === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = papel;
    jest.resetModules();
    (require('src/config/app.config') as AppConfigModulo).resetAppConfig();
  };

  afterEach(() => definirPapel(papelOriginal));

  /**
   * Importa o módulo com o papel informado e instancia os providers que ele
   * declara (dependências trocadas por dublês): é o que o Nest criaria no boot.
   */
  async function carregar(papel: string | undefined) {
    definirPapel(papel);

    const { Test } = require('@nestjs/testing') as NestTesting;
    const { FuelSessionModule } =
      require('src/fuel-session/fuel-session.module') as ModuloFuel;
    const { FuelEconomyProcessor } =
      require('src/fuel-session/processors/fuel-economy.processor') as ProcessorFuel;
    const { FuelSessionService } =
      require('src/fuel-session/services/fuel-session.service') as ServiceFuel;

    const providers = Reflect.getMetadata(
      'providers',
      FuelSessionModule,
    ) as Provider[];
    const modulo = await Test.createTestingModule({ providers })
      .useMocker(() => ({}))
      .compile();

    return { providers, modulo, FuelEconomyProcessor, FuelSessionService };
  }

  it.each(['api', 'pdf'])(
    'papel %s: o processor não é registrado nem instanciado; o service continua disponível',
    async (papel) => {
      const { providers, modulo, FuelEconomyProcessor, FuelSessionService } =
        await carregar(papel);

      expect(providers).not.toContain(FuelEconomyProcessor);
      expect(() => modulo.get(FuelEconomyProcessor, { strict: false })).toThrow(
        /could not find FuelEconomyProcessor/i,
      );
      expect(modulo.get(FuelSessionService)).toBeInstanceOf(FuelSessionService);
    },
  );

  it.each(['worker', 'all', undefined])(
    'papel %s: o processor é registrado e instanciado',
    async (papel) => {
      const { providers, modulo, FuelEconomyProcessor, FuelSessionService } =
        await carregar(papel);

      expect(providers).toContain(FuelEconomyProcessor);
      expect(modulo.get(FuelEconomyProcessor)).toBeInstanceOf(
        FuelEconomyProcessor,
      );
      expect(modulo.get(FuelSessionService)).toBeInstanceOf(FuelSessionService);
    },
  );
});
