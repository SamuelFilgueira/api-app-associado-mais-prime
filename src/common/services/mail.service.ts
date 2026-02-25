import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.SENHA_APP,
      },
    });
  }

  async sendPasswordReset(to: string, newPassword: string): Promise<void> {
    const mailOptions: nodemailer.SendMailOptions = {
      from: `"Benefícios App" <${process.env.GMAIL_USER}>`,
      to,
      subject: 'Redefinição de Senha',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333;">Redefinição de Senha</h2>
          <p>Recebemos uma solicitação de redefinição de senha para sua conta.</p>
          <p>Sua nova senha é:</p>
          <div style="background: #f4f4f4; border-radius: 6px; padding: 12px 20px; font-size: 22px; font-weight: bold; letter-spacing: 2px; text-align: center; color: #222;">
            ${newPassword}
          </div>
          <p style="margin-top: 20px;">Recomendamos que você <strong>altere essa senha</strong> após o seu próximo acesso.</p>
          <p style="color: #888; font-size: 12px;">Se você não solicitou a redefinição de senha, ignore este e-mail.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`E-mail de redefinição de senha enviado para: ${to}`);
    } catch (error) {
      this.logger.error(`Falha ao enviar e-mail para ${to}`, error);
      throw error;
    }
  }
}
