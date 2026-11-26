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

/**
 * Prazos do envio de e-mail.
 *
 * Sem eles, o SDK da AWS não tem timeout nenhum e o nodemailer espera 2 min
 * pela conexão SMTP: se o provedor fica inacessível, a requisição HTTP fica
 * pendurada até o proxy (Nginx, 60 s) ou o próprio app (iOS, 60 s) desistir, e
 * o usuário vê "Network request failed" em vez de uma resposta da API. Os
 * valores ficam bem abaixo desses 60 s para a API sempre responder primeiro.
 */
export const MAIL_PRAZOS = {
  /** Prazo total do envio pelo SES (inclui as tentativas internas do SDK). */
  sesTotalMs: 12_000,
  /** Abertura da conexão TCP com o SMTP do Gmail. */
  smtpConexaoMs: 10_000,
  /** Espera pela saudação do servidor SMTP depois de conectar. */
  smtpSaudacaoMs: 10_000,
  /** Inatividade do socket SMTP (não é prazo total: anexos grandes passam). */
  smtpInatividadeMs: 30_000,
} as const;

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
