import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { debugLog } from 'src/shared/debug-log.util';

/** Prazo de cada envio à Suri. */
const SURI_TIMEOUT_MS = 15_000;

/** Limite do corpo da resposta da Suri gravado no log de erro. */
const RESPOSTA_MAX_CHARS = 500;

/**
 * Envio de notificação via Suri (WhatsApp) por template.
 *
 * Bloco antes duplicado literal em `SgaService.criarBoletoReativacao` e
 * `BoletoVerificacaoProcessor` — diferiam apenas no template e nos parâmetros.
 *
 * Comportamento preservado: `validateStatus: () => true` (respostas HTTP de
 * erro do Suri NÃO lançam); apenas falha de rede propaga para o chamador,
 * que decide como logar (mantém o contexto de debugLog de cada fluxo).
 * Resposta não-2xx da Suri é registrada como erro (status + corpo), pois é
 * ali que a Suri informa o motivo (ex.: template inexistente no bot).
 */
@Injectable()
export class SuriNotificacaoService {
  private readonly logger = new Logger(SuriNotificacaoService.name);

  /** Envia o template; resposta de erro da Suri só vai para o log. */
  async enviarTemplate(params: EnvioDeTemplateSuri): Promise<void> {
    await this.enviarTemplateComResultado(params);
  }

  /**
   * Mesmo envio, devolvendo se a Suri aceitou (`aceito`) e o status HTTP —
   * para quem precisa decidir entre tentar de novo (429/5xx) e desistir
   * (4xx: template inexistente, telefone inválido).
   */
  async enviarTemplateComResultado(
    params: EnvioDeTemplateSuri,
  ): Promise<{ aceito: boolean; status: number }> {
    const primeiroNome = params.nome.trim().split(/\s+/)[0] ?? '';
    const primeiroNomeFormatado = primeiroNome
      ? `${primeiroNome.charAt(0).toUpperCase()}${primeiroNome.slice(1).toLowerCase()}`
      : '';
    const phoneNormalized = '55' + params.telefoneCelular.replace(/\D/g, '');

    const response = await axios.post(
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
        // Sem prazo, uma Suri pendurada segura o job do boleto (e a fila,
        // que tem concorrência 1) até o processo reiniciar.
        timeout: SURI_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );

    const aceito = response.status >= 200 && response.status < 300;
    if (!aceito) {
      this.logger.error(
        debugLog(
          SuriNotificacaoService.name,
          `Suri [${params.contexto ?? 'suri'}] recusou o envio (HTTP ${response.status})`,
          params.debugId,
          {
            templateId: params.templateId ?? 'AUSENTE',
            telefone: mascararTelefone(phoneNormalized),
            resposta: resumirResposta(response.data),
          },
        ),
      );
    }
    return { aceito, status: response.status };
  }
}

export interface EnvioDeTemplateSuri {
  nome: string;
  telefoneCelular: string;
  templateId: string | undefined;
  /** Parâmetros do template após o primeiro nome (ex.: link do boleto). */
  parametrosExtras?: string[];
  /** Identifica o fluxo no log de erro (ex.: `boleto-reativacao`). */
  contexto?: string;
  debugId?: string;
}

/** `5531988887777` → `55319****7777` (mantém DDI/DDD e os 4 finais). */
export function mascararTelefone(digitos: string): string {
  if (!digitos) return '(vazio)';
  if (digitos.length <= 6) return '*'.repeat(digitos.length);
  const inicio = digitos.slice(0, Math.min(5, digitos.length - 4));
  const fim = digitos.slice(-4);
  return `${inicio}${'*'.repeat(digitos.length - inicio.length - 4)}${fim}`;
}

function resumirResposta(data: unknown): string {
  let texto: string;
  try {
    texto = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    texto = String(data);
  }
  if (!texto) return '(vazio)';
  return texto.length > RESPOSTA_MAX_CHARS
    ? `${texto.slice(0, RESPOSTA_MAX_CHARS)}…`
    : texto;
}
