import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { join } from 'path';

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
      from: `"Mais Prime App" <${process.env.GMAIL_USER}>`,
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

  async sendRevistoriaEmail(
    chassi: string,
    photoUrls: string[] = [],
  ): Promise<void> {
    const attachments = photoUrls.map((photoUrl, index) => ({
      filename: `reinspection-${index + 1}${this.getExtensionFromPath(photoUrl)}`,
      path: join(process.cwd(), photoUrl),
      cid: `reinspection-photo-${index + 1}`,
    }));

    const imagesHtml = attachments.length
      ? attachments
          .map(
            (attachment, index) => `
              <div style="margin-top: 12px;">
                <p style="margin: 0 0 8px 0; color: #555; font-size: 13px;">Foto ${index + 1}</p>
                <img src="cid:${attachment.cid}" alt="Foto da revistoria ${index + 1}" style="max-width: 100%; border-radius: 6px; border: 1px solid #e0e0e0;" />
              </div>
            `,
          )
          .join('')
      : '<p style="color: #888;">Nenhuma imagem local foi encontrada para este registro.</p>';

    const mailOptions: nodemailer.SendMailOptions = {
      from: `"Mais Prime App" <${process.env.GMAIL_USER}>`,
      to: 'leumas685@gmail.com',
      subject: 'Nova Vistoria Recebida',
      html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333;">Fotos de revistoria adicionadas para o chassi ${chassi} </h2>
          <p>.</p>
          <p>Foi recebida uma nova solicitação de revistoria para o chassi:</p>
          <div style="background: #f4f4f4; border-radius: 6px; padding: 12px 20px; font-size: 22px; font-weight: bold; letter-spacing: 2px; text-align: center; color: #222;">
            ${chassi}
          </div>
          <div style="margin-top: 20px;">
            <h3 style="color: #333; margin-bottom: 10px;">Imagens recebidas</h3>
            ${imagesHtml}
          </div>
          <p style="color: #888; font-size: 12px;">Em caso de dúvidas, entre em contato com o suporte.</p>
        </div>
      `,
      attachments,
    };
    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `E-mail de revistoria enviado para: leumas685@gmail.com | imagens=${attachments.length}`,
      );
    } catch (error) {
      this.logger.error(
        `Falha ao enviar e-mail para leumas685@gmail.com`,
        error,
      );
      throw error;
    }
  }

  private getExtensionFromPath(pathValue: string): string {
    const dotIndex = pathValue.lastIndexOf('.');
    if (dotIndex === -1) {
      return '.jpg';
    }

    return pathValue.substring(dotIndex);
  }
}
