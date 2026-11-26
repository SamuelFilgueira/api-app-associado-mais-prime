import { Injectable, Logger } from '@nestjs/common';
import { MailService } from 'src/infra/mail/mail.service';
import { debugLog } from 'src/shared/debug-log.util';
import { DomainError, IntegrationError } from 'src/shared/erros/erros';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { suriTemplates } from 'src/config/integracoes.config';

/** Payload do evento `boleto.pago` (outbox). */
export interface EventoBoletoPago {
  nossoNumero?: string;
  debugId?: string;
}

export interface ResultadoDosAvisos {
  /** `enviado` agora, ou `ja_enviado` numa execução anterior. */
  email: 'enviado' | 'ja_enviado';
  whatsapp: 'enviado' | 'ja_enviado' | 'recusado' | 'sem_contato';
}

/**
 * Avisos do boleto de reativação pago: e-mail para a equipe e WhatsApp
 * (Suri) para o associado. Consome o evento `boleto.pago`, gravado no outbox
 * na mesma transação que marcou `pago = true` — o aviso não depende mais de
 * a reativação no SGA dar certo, nem se perde se o processo cair logo depois
 * de detectar o pagamento.
 *
 * Idempotente (o job pode ser entregue mais de uma vez):
 *  - e-mail: `pagoNotificadoEm` é reivindicado antes do envio — só um
 *    chamador envia; se o envio falhar, o marcador é devolvido e o job falha
 *    para tentar de novo;
 *  - WhatsApp: mesmo desenho, com `suriNotificadoEm`. Recusa definitiva da
 *    Suri (template inexistente, telefone inválido) mantém o marcador: não
 *    adianta insistir. Instabilidade (rede, 429, 5xx) devolve o marcador e
 *    faz o job falhar, para a nova tentativa enviar.
 */
@Injectable()
export class AvisosBoletoPagoService {
  private readonly logger = new Logger(AvisosBoletoPagoService.name);

  constructor(
    private readonly pagamentos: PagamentoBoletoRepository,
    private readonly mailService: MailService,
    private readonly suriNotificacaoService: SuriNotificacaoService,
  ) {}

  async executar(evento: EventoBoletoPago): Promise<ResultadoDosAvisos> {
    const nossoNumero = evento.nossoNumero ? String(evento.nossoNumero) : '';
    const pagamento = nossoNumero
      ? await this.pagamentos.buscarPorNossoNumero(nossoNumero)
      : null;
    // O evento nasce na transação que grava o pagamento: sem a linha paga,
    // repetir não muda nada.
    if (!pagamento?.pago) {
      throw new DomainError(
        'BOLETO_PAGO_SEM_REGISTRO',
        `Evento boleto.pago sem pagamento gravado (nosso_numero=${nossoNumero || 'ausente'})`,
      );
    }

    const email = await this.avisarEquipe(pagamento, evento.debugId);
    const whatsapp = await this.avisarAssociado(
      pagamento,
      nossoNumero,
      evento.debugId,
    );
    return { email, whatsapp };
  }

  private async avisarEquipe(
    pagamento: { id: number; userVehicleId: number },
    debugId?: string,
  ): Promise<ResultadoDosAvisos['email']> {
    const marcadoEm = new Date();
    const meu = await this.pagamentos.reivindicarAvisoPorEmail(
      pagamento.id,
      marcadoEm,
    );
    if (!meu) return 'ja_enviado';

    try {
      const veiculo = await this.pagamentos.veiculoDoBoleto(
        pagamento.userVehicleId,
      );
      await this.mailService.sendBoletoRevistoriaPago(
        veiculo?.chassi ?? 'N/A',
        veiculo?.plate ?? null,
        debugId,
      );
      return 'enviado';
    } catch (error) {
      // O e-mail não saiu: devolve o marcador e deixa o job falhar, para a
      // nova tentativa enviar.
      await this.pagamentos.devolverAvisoPorEmail(pagamento.id, marcadoEm);
      throw error;
    }
  }

  private async avisarAssociado(
    pagamento: {
      id: number;
      nomeAssociado: string | null;
      telefoneAssociado: string | null;
    },
    nossoNumero: string,
    debugId?: string,
  ): Promise<ResultadoDosAvisos['whatsapp']> {
    const { nomeAssociado: nome, telefoneAssociado: telefone } = pagamento;
    if (!nome || !telefone) {
      this.logger.warn(
        debugLog(
          AvisosBoletoPagoService.name,
          'Notificação Suri (boleto pago) não enviada — nome ou telefone ausente',
          debugId,
          { nossoNumero, temNome: !!nome, temTelefone: !!telefone },
        ),
      );
      return 'sem_contato';
    }

    const marcadoEm = new Date();
    const meu = await this.pagamentos.reivindicarAvisoPorWhatsapp(
      pagamento.id,
      marcadoEm,
    );
    if (!meu) return 'ja_enviado';

    let envio: { aceito: boolean; status: number };
    try {
      envio = await this.suriNotificacaoService.enviarTemplateComResultado({
        nome,
        telefoneCelular: telefone,
        templateId: suriTemplates().boletoPago,
        contexto: 'boleto-pago',
        debugId,
      });
    } catch (error) {
      // Sem resposta da Suri: nada se sabe do envio. Devolve o marcador e
      // deixa o job falhar, para a nova tentativa enviar.
      await this.pagamentos.devolverAvisoPorWhatsapp(pagamento.id, marcadoEm);
      throw error;
    }
    if (envio.aceito) return 'enviado';

    // 429/5xx: a Suri está fora — vale tentar de novo. Os demais 4xx
    // (template inexistente, telefone inválido) não mudam com retry; a
    // recusa já foi registrada pelo SuriNotificacaoService e o marcador fica.
    if (envio.status === 429 || envio.status >= 500) {
      await this.pagamentos.devolverAvisoPorWhatsapp(pagamento.id, marcadoEm);
      throw new IntegrationError({
        vendor: 'suri',
        tipo: 'indisponivel',
        statusVendor: envio.status,
        message: `Suri respondeu HTTP ${envio.status} ao avisar o boleto ${nossoNumero} pago`,
      });
    }
    return 'recusado';
  }
}
