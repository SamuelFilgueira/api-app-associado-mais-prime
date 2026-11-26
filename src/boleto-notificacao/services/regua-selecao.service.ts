import { Injectable, Logger } from '@nestjs/common';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  GrupoAssociado,
  Selecao,
  selecionarDestinatarios,
  usuariosDaBase,
} from 'src/boleto-notificacao/domain/regua-elegibilidade';
import {
  ModeloDeMensagem,
  TipoMensagem,
} from 'src/boleto-notificacao/domain/regua-tipos';
import { ReguaDestinatarioRepository } from 'src/boleto-notificacao/repositories/regua-destinatario.repository';
import { ReguaLogRepository } from 'src/boleto-notificacao/repositories/regua-log.repository';

/**
 * Caso de uso: selecionar os destinatários de uma etapa. Junta o que vem do
 * banco (usuários do app e logs já gravados) e entrega para a regra pura
 * decidir quem recebe.
 */
@Injectable()
export class ReguaSelecaoService {
  private readonly logger = new Logger(ReguaSelecaoService.name);

  constructor(
    private readonly destinatarios: ReguaDestinatarioRepository,
    private readonly logs: ReguaLogRepository,
    private readonly push: PushGateway,
  ) {}

  async selecionar(entrada: {
    tag: string;
    tenant: string;
    tipo: TipoMensagem;
    grupos: GrupoAssociado[];
    modelo: ModeloDeMensagem;
  }): Promise<Selecao> {
    const { tenant, tipo, grupos } = entrada;

    // Usuários do app (CPF único na base local; respeita o tenant quando informado)
    const cpfs = Array.from(new Set(grupos.map((g) => g.cpf)));
    const { porCpf, deOutraBase } = usuariosDaBase(
      await this.destinatarios.ativosPorCpf(cpfs),
      tenant,
    );
    if (deOutraBase > 0) {
      this.logger.warn(
        `${entrada.tag} ${deOutraBase} usuário(s) com CPF do lote pertencem a outro tenant e foram ignorados`,
      );
    }

    // Idempotência: já existe log para (tenant, associado, vencimento, tipo)?
    const logs = await this.logs.buscarExistentes(tenant, tipo, grupos);

    return selecionarDestinatarios({
      grupos,
      usuarioPorCpf: porCpf,
      logs,
      tokenValido: (token) => this.push.tokenValido(token),
      modelo: entrada.modelo,
      agora: this.agora(),
    });
  }

  /** Relógio da seleção (idade dos logs órfãos). */
  protected agora(): Date {
    return new Date();
  }
}
