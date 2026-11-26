import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TENANT } from 'src/config/tenant.config';
import {
  descreverRegraRevistoria,
  getRegraRevistoria,
} from 'src/config/revistoria-regra.config';
import { exigirBase } from 'src/shared/tenant/tenant-context';

/**
 * Expõe a regra de revistoria por base (situações que exigem revistoria e
 * template de fotos por tipo de veículo do SGA). A regra em si vive em
 * `src/config/revistoria-regra.config.ts`.
 */
@Injectable()
export class RevistoriaRegraService implements OnModuleInit {
  private readonly logger = new Logger(RevistoriaRegraService.name);

  /**
   * Registra no boot qual perfil de regra cada base usa — evita que uma base
   * com nome inesperado caia na regra padrão sem ninguém perceber.
   */
  onModuleInit() {
    for (const base of TENANT.baseNames) {
      const regra = getRegraRevistoria(base);
      this.logger.log(
        `[${base}] regra de revistoria: perfil=${regra.perfil} | situações=${regra.situacoes.join(', ')} | conta boleto=${regra.boleto.codigoConta} | situação após boleto=${regra.boleto.situacaoVeiculoAposBoleto ?? 'não altera'}`,
      );
    }
  }

  /**
   * Regra da base do associado (`GET /reinspection/regra`). Sem base
   * resolvida no token a rota falha (422 `BASE_NAO_RESOLVIDA`) — antes
   * devolvia, em silêncio, a regra da base padrão do deploy.
   */
  getRegra(baseOrigin?: string | null) {
    return descreverRegraRevistoria(
      exigirBase(baseOrigin, 'regra de revistoria do associado'),
    );
  }

  /** Regras de todas as bases deste deploy (painel). */
  getRegras() {
    return TENANT.baseNames.map((base) => descreverRegraRevistoria(base));
  }
}
