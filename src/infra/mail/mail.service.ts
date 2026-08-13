import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { join } from 'path';
import { debugLog } from 'src/shared/debug-log.util';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { TENANT } from 'src/config/tenant.config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;
  private sesClient: SESv2Client;

  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.SENHA_APP,
      },
    });

    this.sesClient = new SESv2Client({
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  async sendPasswordReset(to: string, newPassword: string): Promise<void> {
    const html = `
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
    `;

    const command = new SendEmailCommand({
      FromEmailAddress: process.env.MAIL_FROM!,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: 'Redefinição de Senha', Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } },
        },
      },
    });

    try {
      await this.sesClient.send(command);
    } catch (error) {
      this.logger.error(`Falha ao enviar e-mail via SES para ${to}`, error);
      throw error;
    }
  }

  async sendRevistoriaEmail(
    chassi: string,
    plate: string | null,
    debugId?: string,
    photoUrls: string[] = [],
  ): Promise<void> {
    const safePlate = plate ?? 'N/A';

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
      from: `"${TENANT.appName}" <${process.env.GMAIL_USER}>`,
      to: TENANT.mailPrevia,
      subject: 'Nova Vistoria Recebida',
      html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333;">Fotos de revistoria adicionadas para o chassi ${chassi} </h2>
          <p>.</p>
          <p>Foi recebida uma nova solicitação de revistoria para o chassi/placa:</p>
          <div style="background: #f4f4f4; border-radius: 6px; padding: 12px 20px; font-size: 22px; font-weight: bold; letter-spacing: 2px; text-align: center; color: #222;">
            Chassi: ${chassi}<br />
            Placa: ${safePlate}
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
    } catch (error) {
      this.logger.error(
        debugLog(
          MailService.name,
          'Falha ao enviar e-mail de revistoria',
          debugId,
          {
            chassi,
            plate: safePlate,
            destino: TENANT.mailPrevia,
            error: error instanceof Error ? error.message : String(error),
          },
        ),
      );
      throw error;
    }
  }

  async sendRevistoriaAprovadaEmail(
    chassi: string,
    plate: string | null,
    debugId?: string,
  ): Promise<void> {
    const safePlate = plate ?? 'N/A';

    const mailOptions: nodemailer.SendMailOptions = {
      from: `"${TENANT.appName}" <${process.env.GMAIL_USER}>`,
      to: TENANT.mailCobranca,
      subject: 'Revistoria Aprovada com Sucesso',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #2e7d32;">Revistoria Aprovada ✓</h2>
          <p>A revistoria do veículo abaixo foi <strong>aprovada com sucesso e o boleto foi gerado de forma automática!</strong>:</p>
          <div style="background: #f4f4f4; border-radius: 6px; padding: 12px 20px; font-size: 22px; font-weight: bold; letter-spacing: 2px; text-align: center; color: #222;">
            Chassi: ${chassi}<br />
            Placa: ${safePlate}
          </div>
          <p style="margin-top: 20px;">As fotos foram verificadas e a revistoria foi concluída com êxito.</p>
          <p style="color: #888; font-size: 12px;">Em caso de dúvidas, entre em contato com o suporte.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      this.logger.error(
        debugLog(
          MailService.name,
          'Falha ao enviar e-mail de revistoria aprovada',
          debugId,
          {
            chassi,
            plate: safePlate,
            destino: TENANT.mailCobranca,
            error: error instanceof Error ? error.message : String(error),
          },
        ),
      );
      throw error;
    }
  }

  async sendBoletoRevistoriaPago(
    chassi: string,
    plate: string | null,
    debugId?: string,
  ): Promise<void> {
    const safePlate = plate ?? 'N/A';

    const mailOptions: nodemailer.SendMailOptions = {
      from: `"${TENANT.appName}" <${process.env.GMAIL_USER}>`,
      to: [TENANT.mailCobranca, TENANT.mailPrevia],
      subject: `Boleto para placa ${safePlate} pago - Revistoria Aprovada`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #2e7d32;">Boleto Pago - Revistoria Aprovada ✓</h2>
          <p>O boleto do veículo abaixo foi <strong>pago com sucesso e o veículo está ATIVO</strong>:</p>
          <div style="background: #f4f4f4; border-radius: 6px; padding: 12px 20px; font-size: 22px; font-weight: bold; letter-spacing: 2px; text-align: center; color: #222;">
            Chassi: ${chassi}<br />
            Placa: ${safePlate}
          </div>
          <p style="color: #888; font-size: 12px;">Em caso de dúvidas, entre em contato com o suporte.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      this.logger.error(
        debugLog(
          MailService.name,
          'Falha ao enviar e-mail de boleto pago',
          debugId,
          {
            chassi,
            plate: safePlate,
            destino: [TENANT.mailCobranca, TENANT.mailPrevia],
            error: error instanceof Error ? error.message : String(error),
          },
        ),
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

  async sendFotoRecusadaReenviadaEmail(
    chassi: string,
    plate: string | null,
    debugId?: string,
    photoUrls: string[] = [],
  ): Promise<void> {
    const safePlate = plate ?? 'N/A';

    const attachments = photoUrls.map((photoUrl, index) => ({
      filename: `reinspection-resend-${index + 1}${this.getExtensionFromPath(photoUrl)}`,
      path: join(process.cwd(), photoUrl),
      cid: `reinspection-resend-photo-${index + 1}`,
    }));

    const imagesHtml = attachments.length
      ? attachments
          .map(
            (attachment, index) => `
              <div style="margin-top: 12px;">
                <p style="margin: 0 0 8px 0; color: #555; font-size: 13px;">Foto ${index + 1}</p>
                <img src="cid:${attachment.cid}" alt="Foto reenviada ${index + 1}" style="max-width: 100%; border-radius: 6px; border: 1px solid #e0e0e0;" />
              </div>
            `,
          )
          .join('')
      : '<p style="color: #888;">Nenhuma imagem local foi encontrada para este registro.</p>';

    const mailOptions: nodemailer.SendMailOptions = {
      from: `"${TENANT.appName}" <${process.env.GMAIL_USER}>`,
      to: TENANT.mailPrevia,
      subject: 'Revistoria - Foto recusada reenviada',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333;">Foto recusada reenviada — Chassi ${chassi} / Placa ${safePlate}</h2>
          <p>Uma foto que havia sido reprovada foi reenviada pelo associado para o veículo:</p>
          <div style="background: #f4f4f4; border-radius: 6px; padding: 12px 20px; font-size: 22px; font-weight: bold; letter-spacing: 2px; text-align: center; color: #222;">
            Chassi: ${chassi}<br />
            Placa: ${safePlate}
          </div>
          <p style="margin-top: 16px;">A revistoria foi movida de volta para <strong>EM AN\u00c1LISE</strong> e a nova foto foi encaminhada \u00e0 Hinova.</p>
          <div style="margin-top: 20px;">
            <h3 style="color: #333; margin-bottom: 10px;">Nova imagem enviada</h3>
            ${imagesHtml}
          </div>
          <p style="color: #888; font-size: 12px;">Em caso de d\u00favidas, entre em contato com o suporte.</p>
        </div>
      `,
      attachments,
    };

    try {
      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      this.logger.error(
        debugLog(
          MailService.name,
          'Falha ao enviar e-mail de foto recusada reenviada',
          debugId,
          {
            chassi,
            plate: safePlate,
            error: error instanceof Error ? error.message : String(error),
          },
        ),
      );
      throw error;
    }
  }
}
