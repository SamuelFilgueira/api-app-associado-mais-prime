/* eslint-disable @typescript-eslint/no-require-imports -- o módulo precisa ser reavaliado a cada caso (o papel é lido na importação), o que só o `require` depois de `jest.resetModules()` faz */
import type { Provider } from '@nestjs/common';

type AppConfigModulo = typeof import('src/config/app.config');
type ModuloNotificacoes =
  typeof import('src/notifications/notifications.module');
type NestTesting = typeof import('@nestjs/testing');

/**
 * Papel do processo (`APP_ROLE`) e montagem do módulo: os três processors
 * (alerta, marketing agendado + varredura, massa) só existem no `worker`; a
 * fachada e os casos de uso existem em qualquer papel (a `api` só produz
 * jobs). As dependências de fora do módulo entram como dublês — o que se
 * prova aqui é que os providers do próprio módulo se resolvem entre si, sem
 * ciclo.
 */
describe('NotificationsModule — papel do processo (APP_ROLE)', () => {
  const papelOriginal = process.env.APP_ROLE;

  const definirPapel = (papel: string | undefined) => {
    if (papel === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = papel;
    jest.resetModules();
    (require('src/config/app.config') as AppConfigModulo).resetAppConfig();
  };

  afterEach(() => definirPapel(papelOriginal));

  async function carregar(papel: string | undefined) {
    definirPapel(papel);

    const { Test } = require('@nestjs/testing') as NestTesting;
    const { NotificationsModule } =
      require('src/notifications/notifications.module') as ModuloNotificacoes;
    const classes = {
      NotificationsService:
        require('src/notifications/services/notifications.service')
          .NotificationsService,
      SituacaoCadastroNotificationService:
        require('src/notifications/services/situacao-cadastro-notification.service')
          .SituacaoCadastroNotificationService,
      MarketingAgendamentoService:
        require('src/notifications/services/marketing-agendamento.service')
          .MarketingAgendamentoService,
      PushVarreduraService:
        require('src/notifications/services/push-varredura.service')
          .PushVarreduraService,
      NotificationProcessor:
        require('src/notifications/processors/notification.processor')
          .NotificationProcessor,
      MarketingAgendadaProcessor:
        require('src/notifications/processors/marketing-agendada.processor')
          .MarketingAgendadaProcessor,
      PushMassaProcessor:
        require('src/notifications/processors/push-massa.processor')
          .PushMassaProcessor,
    };

    const providers = Reflect.getMetadata(
      'providers',
      NotificationsModule,
    ) as Provider[];
    const modulo = await Test.createTestingModule({ providers })
      .useMocker(() => ({}))
      .compile();

    return { providers, modulo, classes };
  }

  const processors = [
    'NotificationProcessor',
    'MarketingAgendadaProcessor',
    'PushMassaProcessor',
  ] as const;
  const casosDeUso = [
    'NotificationsService',
    'SituacaoCadastroNotificationService',
    'MarketingAgendamentoService',
    'PushVarreduraService',
  ] as const;

  it.each(['api', 'pdf'])(
    'papel %s: nenhum processor é registrado; a fachada e os casos de uso continuam disponíveis',
    async (papel) => {
      const { providers, modulo, classes } = await carregar(papel);

      for (const nome of processors) {
        expect(providers).not.toContain(classes[nome]);
      }
      for (const nome of casosDeUso) {
        expect(modulo.get(classes[nome])).toBeInstanceOf(classes[nome]);
      }
    },
  );

  it.each(['worker', 'all', undefined])(
    'papel %s: os três processors são registrados e instanciados',
    async (papel) => {
      const { providers, modulo, classes } = await carregar(papel);

      for (const nome of [...processors, ...casosDeUso]) {
        expect(providers).toContain(classes[nome]);
        expect(modulo.get(classes[nome])).toBeInstanceOf(classes[nome]);
      }
    },
  );

  it('só a fachada é exportada para os outros módulos', () => {
    definirPapel('all');
    const { NotificationsModule } =
      require('src/notifications/notifications.module') as ModuloNotificacoes;
    const { NotificationsService } =
      require('src/notifications/services/notifications.service') as typeof import('src/notifications/services/notifications.service');

    expect(Reflect.getMetadata('exports', NotificationsModule)).toEqual([
      NotificationsService,
    ]);
  });
});
