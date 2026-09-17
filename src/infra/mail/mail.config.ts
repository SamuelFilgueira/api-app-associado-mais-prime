import { Logger } from '@nestjs/common';

/**
 * Provedor do e-mail de redefinição de senha (`MailService.sendPasswordReset`).
 *
 * - `ses`   (default) — Amazon SES via `MAIL_FROM` + `AWS_*`. Comportamento
 *           original, usado pela Mais Prime / Mais Prime RS.
 * - `gmail` — SMTP do Gmail com senha de app (`GMAIL_USER` + `SENHA_APP`), o
 *           mesmo transporte já usado pelos e-mails de revistoria/cobrança.
 *           Usado pela Hertz enquanto não há conta SES.
 *
 * Env: `MAIL_PASSWORD_RESET_PROVIDER`. Os demais e-mails (revistoria, cobrança,
 * boleto pago) continuam sempre no Gmail, independentemente desta env.
 */
export type MailPasswordResetProvider = 'ses' | 'gmail';

export interface MailConfig {
  passwordResetProvider: MailPasswordResetProvider;
}

const PROVEDORES_VALIDOS: readonly MailPasswordResetProvider[] = [
  'ses',
  'gmail',
];

export function carregarMailConfig(): MailConfig {
  const logger = new Logger('MailConfig');
  const bruto = (process.env.MAIL_PASSWORD_RESET_PROVIDER ?? 'ses')
    .trim()
    .toLowerCase();

  if (!PROVEDORES_VALIDOS.includes(bruto as MailPasswordResetProvider)) {
    logger.warn(
      `MAIL_PASSWORD_RESET_PROVIDER="${bruto}" inválido (esperado ses|gmail) — usando "ses"`,
    );
    return { passwordResetProvider: 'ses' };
  }

  const provider = bruto as MailPasswordResetProvider;
  if (provider === 'gmail') {
    logger.log(
      'E-mail de redefinição de senha via Gmail SMTP (MAIL_PASSWORD_RESET_PROVIDER=gmail)',
    );
    if (!process.env.GMAIL_USER || !process.env.SENHA_APP) {
      logger.warn(
        'MAIL_PASSWORD_RESET_PROVIDER=gmail sem GMAIL_USER/SENHA_APP — envio de redefinição de senha vai falhar',
      );
    }
  }

  return { passwordResetProvider: provider };
}
