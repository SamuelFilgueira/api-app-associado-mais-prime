import { Injectable } from '@nestjs/common';
import axios from 'axios';

/**
 * Envio de notificação via Suri (WhatsApp) por template.
 *
 * Bloco antes duplicado literal em `SgaService.criarBoletoReativacao` e
 * `BoletoVerificacaoProcessor` — diferiam apenas no template e nos parâmetros.
 *
 * Comportamento preservado: `validateStatus: () => true` (respostas HTTP de
 * erro do Suri NÃO lançam); apenas falha de rede propaga para o chamador,
 * que decide como logar (mantém o contexto de debugLog de cada fluxo).
 */
@Injectable()
export class SuriNotificacaoService {
  async enviarTemplate(params: {
    nome: string;
    telefoneCelular: string;
    templateId: string | undefined;
    /** Parâmetros do template após o primeiro nome (ex.: link do boleto). */
    parametrosExtras?: string[];
  }): Promise<void> {
    const primeiroNome = params.nome.trim().split(/\s+/)[0] ?? '';
    const primeiroNomeFormatado = primeiroNome
      ? `${primeiroNome.charAt(0).toUpperCase()}${primeiroNome.slice(1).toLowerCase()}`
      : '';
    const phoneNormalized = '55' + params.telefoneCelular.replace(/\D/g, '');

    await axios.post(
      process.env.suri_baseUrl!,
      {
        user: {
          name: params.nome,
          phone: phoneNormalized,
          email: null,
          gender: 0,
          channelId: process.env.channelId,
          channelType: 1,
          defaultDepartmentId: null,
        },
        message: {
          templateId: params.templateId,
          BodyParameters: [
            primeiroNomeFormatado,
            ...(params.parametrosExtras ?? []),
          ],
        },
        responseAction: {
          type: 1,
          sendTo: process.env.sendTo,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.token_suri}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      },
    );
  }
}
