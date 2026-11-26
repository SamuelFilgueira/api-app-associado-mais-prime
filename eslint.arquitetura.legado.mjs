// Exceções do legado às regras de `eslint.arquitetura.mjs`.
//
// Estas listas SÓ DIMINUEM. Arquivo novo nunca entra aqui: se a regra
// incomoda, o código novo está no lugar errado (ver docs/ARQUITETURA_2026-11.md).
// Ao corrigir um arquivo, remova a linha dele.
//
// `src/__nenhum__.ts` é só o marcador de lista vazia (o ESLint não aceita
// `files: []`).
export const LEGADO = {
  /** Leem `process.env` fora de `src/config` (26 arquivos). */
  processEnv: [
    'src/analytics/controllers/analytics.controller.ts',
    'src/analytics/services/analytics-journey.service.ts',
    'src/analytics/services/analytics.service.ts',
    'src/app-version/repositories/app-version.repository.ts',
    'src/associado-sorte/config/associado-sorte.config.ts',
    'src/auth/config/auth.config.ts',
    'src/auth/controllers/auth.controller.ts',
    'src/boleto-notificacao/config/boleto-notificacao.config.ts',
    'src/database/prisma.service.ts',
    'src/expo-updates/config/expo-updates.config.ts',
    'src/infra/guards/admin-token.guard.ts',
    'src/infra/mail/mail.config.ts',
    'src/infra/mail/mail.service.ts',
    'src/infra/storage/file-upload.service.ts',
    'src/integrations/clubgas/clubgas.client.ts',
    'src/notifications/services/marketing-notification-audit.service.ts',
    'src/oficina/services/oficina.service.ts',
    'src/rastreamento/guards/m7.guard.ts',
    'src/rastreamento/logica/constants/logica.constants.ts',
    'src/rastreamento/logica/services/logica-auth.service.ts',
    'src/rastreamento/m7/constants/m7.constants.ts',
    'src/rastreamento/m7/services/m7-reverse-geocode.service.ts',
    'src/rastreamento/softruck/services/rastreamento-softruck.service.ts',
    'src/sga/config/boleto-reativacao-retry.config.ts',
    'src/sga/config/boleto-verificacao.config.ts',
    'src/sga/services/suri-notificacao.service.ts',
  ],

  /**
   * Importam axios, ioredis, Prisma ou outra camada onde a regra proíbe
   * (6 arquivos).
   */
  importsRestritos: [
    'src/oficina/services/oficina.service.ts',
    'src/rastreamento/m7/providers/m7-redis.provider.ts',
    'src/sga/beneficios-veiculo/services/beneficios-veiculo.service.ts',
    'src/sga/boleto/services/boleto.service.ts',
    'src/sga/helpers/sga-instabilidade.helper.ts',
    'src/sga/services/suri-notificacao.service.ts',
  ],
};
