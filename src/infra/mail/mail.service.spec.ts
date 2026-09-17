const sendMailMock = jest.fn();
const sesSendMock = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));

jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn(() => ({ send: sesSendMock })),
  SendEmailCommand: jest.fn((input: unknown) => ({ input })),
}));

import { MailService } from './mail.service';

/**
 * Cobre a seleção de provedor do e-mail de redefinição de senha:
 * - default (env ausente) e `ses` → SES, exatamente como antes (Mais Prime)
 * - `gmail` → transporte nodemailer do Gmail (Hertz)
 * - valor inválido → cai para SES
 */
describe('MailService.sendPasswordReset — provedor por env', () => {
  const envOriginal = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    sendMailMock.mockResolvedValue({ messageId: 'x' });
    sesSendMock.mockResolvedValue({});
    process.env.GMAIL_USER = 'app@empresa.com.br';
    process.env.SENHA_APP = 'senha-app';
    process.env.MAIL_FROM = 'contato@empresa.com.br';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    delete process.env.MAIL_PASSWORD_RESET_PROVIDER;
  });

  afterAll(() => {
    process.env = envOriginal;
  });

  it('sem env usa SES (comportamento original da Mais Prime)', async () => {
    const service = new MailService();
    await service.sendPasswordReset('usuario@x.com', 'ABC12def3');

    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).not.toHaveBeenCalled();
    const { input } = sesSendMock.mock.calls[0][0] as {
      input: {
        FromEmailAddress: string;
        Destination: { ToAddresses: string[] };
        Content: { Simple: { Body: { Html: { Data: string } } } };
      };
    };
    expect(input.FromEmailAddress).toBe('contato@empresa.com.br');
    expect(input.Destination.ToAddresses).toEqual(['usuario@x.com']);
    expect(input.Content.Simple.Body.Html.Data).toContain('ABC12def3');
  });

  it('MAIL_PASSWORD_RESET_PROVIDER=ses usa SES', async () => {
    process.env.MAIL_PASSWORD_RESET_PROVIDER = 'ses';
    await new MailService().sendPasswordReset('u@x.com', 'S3nh4');
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('MAIL_PASSWORD_RESET_PROVIDER=gmail usa o transporte do Gmail (Hertz)', async () => {
    process.env.MAIL_PASSWORD_RESET_PROVIDER = 'gmail';
    await new MailService().sendPasswordReset('u@x.com', 'S3nh4');

    expect(sesSendMock).not.toHaveBeenCalled();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const opts = sendMailMock.mock.calls[0][0];
    expect(opts.to).toBe('u@x.com');
    expect(opts.subject).toBe('Redefinição de Senha');
    expect(opts.from).toContain('<app@empresa.com.br>');
    expect(opts.html).toContain('S3nh4');
  });

  it('valor inválido cai para SES', async () => {
    process.env.MAIL_PASSWORD_RESET_PROVIDER = 'sendgrid';
    await new MailService().sendPasswordReset('u@x.com', 'S3nh4');
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('propaga erro do Gmail para o chamador', async () => {
    process.env.MAIL_PASSWORD_RESET_PROVIDER = 'gmail';
    sendMailMock.mockRejectedValueOnce(new Error('Invalid login'));
    await expect(
      new MailService().sendPasswordReset('u@x.com', 'S3nh4'),
    ).rejects.toThrow('Invalid login');
  });
});
