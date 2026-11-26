import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  BaseOrigin,
  isTenantBase,
  TENANT,
  tenantEnvName,
  TenantTokenKind,
  valorDaEnvDeCredencial,
} from 'src/config/tenant.config';
import { integracaoNaoConfigurada } from 'src/shared/erros/erros';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

/** Vendor dono de cada credencial (para o erro e para o diagnóstico). */
const VENDOR_DA_CREDENCIAL: Record<TenantTokenKind, Integracao> = {
  sgaUser: 'hinova',
  sgaPassword: 'hinova',
  sgaBaseToken: 'hinova',
  logica: 'logica',
  softruck: 'softruck',
  softruckUsername: 'softruck',
  softruckPassword: 'softruck',
  softruckPublicKey: 'softruck',
  clubgas: 'clubgas',
  m7Token: 'm7',
  m7Codigo: 'm7',
  apiSecretAlloyal: 'alloyal',
  alloyalBusinessId: 'alloyal',
  alloyalBusinessCnpj: 'alloyal',
};

export type Integracao =
  | 'hinova'
  | 'logica'
  | 'softruck'
  | 'clubgas'
  | 'm7'
  | 'alloyal';

export interface CredenciaisHinova {
  usuario: string;
  senha: string;
  /** Tokens de base em ordem de preferência (rotação e failover). */
  tokensBase: string[];
}
export interface CredenciaisLogica {
  token: string;
}
/**
 * A API da Softruck autentica por usuário e senha, mais a chave pública.
 * `SOFTRUCK_TOKEN` não é usado por ela (só por um script de exportação):
 * por isso não é credencial obrigatória nem conta como integração incompleta.
 */
export interface CredenciaisSoftruck {
  usuario: string;
  senha: string;
  chavePublica: string;
}
export interface CredenciaisClubgas {
  token: string;
}
export interface CredenciaisM7 {
  token: string;
  codigo: string;
}
export interface CredenciaisAlloyal {
  apiSecret: string;
  businessId: string;
  businessCnpj: string;
}

/** Até quantos tokens de base numerados (`…1` a `…9`) o SGA aceita por base. */
const MAX_TOKENS_BASE_SGA = 9;

/**
 * Credenciais de vendor por base, tipadas por integração.
 *
 * É o ÚNICO lugar que conhece nome de variável de ambiente de credencial:
 * cada client pede só a sua (`registry.m7(base)`), em vez de receber um
 * resolvedor que enxerga todas.
 *
 * Credencial ausente vira `IntegrationError` do tipo `nao_configurada`
 * (HTTP 503 com `code`), e não mais um `Error` genérico que saía como 500.
 * No boot, o registry relata por base o que está configurado.
 */
@Injectable()
export class TenantCredentialsRegistry implements OnModuleInit {
  private readonly logger = new Logger(TenantCredentialsRegistry.name);

  onModuleInit(): void {
    for (const base of TENANT.baseNames) {
      const faltando = this.integracoesIncompletas(base);
      const resumo = Object.entries(faltando)
        .map(([vendor, envs]) => `${vendor} (${envs.join(', ')})`)
        .join('; ');
      if (resumo) {
        this.logger.warn(
          `[${base}] integrações sem credencial completa: ${resumo}. As rotas que dependem delas respondem 503 INTEGRACAO_NAO_CONFIGURADA.`,
        );
      } else {
        this.logger.log(
          `[${base}] credenciais de todas as integrações presentes`,
        );
      }
    }
  }

  hinova(base: BaseOrigin): CredenciaisHinova {
    return {
      usuario: this.valor(base, 'sgaUser'),
      senha: this.valor(base, 'sgaPassword'),
      tokensBase: this.tokensBaseSga(base),
    };
  }

  logica(base: BaseOrigin): CredenciaisLogica {
    return { token: this.valor(base, 'logica') };
  }

  softruck(base: BaseOrigin): CredenciaisSoftruck {
    return {
      usuario: this.valor(base, 'softruckUsername'),
      senha: this.valor(base, 'softruckPassword'),
      chavePublica: this.valor(base, 'softruckPublicKey'),
    };
  }

  clubgas(base: BaseOrigin): CredenciaisClubgas {
    return { token: this.valor(base, 'clubgas') };
  }

  m7(base: BaseOrigin): CredenciaisM7 {
    return {
      token: this.valor(base, 'm7Token'),
      codigo: this.valor(base, 'm7Codigo'),
    };
  }

  alloyal(base: BaseOrigin): CredenciaisAlloyal {
    return {
      apiSecret: this.valor(base, 'apiSecretAlloyal'),
      businessId: this.valor(base, 'alloyalBusinessId'),
      businessCnpj: this.valor(base, 'alloyalBusinessCnpj'),
    };
  }

  /** Uma credencial avulsa. Prefira os métodos tipados por integração. */
  valor(base: BaseOrigin, tipo: TenantTokenKind): string {
    const nome = this.nomeDaEnv(base, tipo);
    const valor = valorDaEnvDeCredencial(nome);
    if (!valor) {
      this.logger.error(`Variável ${nome} ausente para a base ${base}`);
      throw integracaoNaoConfigurada(VENDOR_DA_CREDENCIAL[tipo], base, nome);
    }
    return valor;
  }

  /**
   * Tokens de base do SGA disponíveis para a base, em ordem de preferência:
   * `TOKEN_BASE_SGA_<BASE>`, `…1`, `…2` (até 9). Mais de um token permite
   * rotação e failover quando a Hinova bloqueia um deles por "extração de
   * dados". Qualquer combinação vale: só o nome puro, só numerados, ou ambos.
   */
  tokensBaseSga(base: BaseOrigin): string[] {
    const nomeBase = this.nomeDaEnv(base, 'sgaBaseToken');
    const nomes = [
      nomeBase,
      ...Array.from(
        { length: MAX_TOKENS_BASE_SGA },
        (_, i) => `${nomeBase}${i + 1}`,
      ),
    ];
    const tokens = nomes
      .map((n) => valorDaEnvDeCredencial(n)?.trim())
      .filter((v): v is string => !!v);
    const unicos = [...new Set(tokens)];

    if (unicos.length === 0) {
      this.logger.error(
        `Variável ${nomeBase} (ou ${nomeBase}1, ${nomeBase}2…) ausente para a base ${base}`,
      );
      throw integracaoNaoConfigurada('hinova', base, nomeBase);
    }
    return unicos;
  }

  /** Nome da variável de ambiente da credencial (para diagnóstico/log). */
  nomeDaEnv(base: BaseOrigin, tipo: TenantTokenKind): string {
    if (!isTenantBase(base)) {
      throw new BaseNaoResolvidaError(`credencial ${tipo}`, base);
    }
    return tenantEnvName(base, tipo);
  }

  /** Por integração, as envs que faltam para a base (vazio = tudo certo). */
  integracoesIncompletas(
    base: BaseOrigin,
  ): Partial<Record<Integracao, string[]>> {
    const faltando: Partial<Record<Integracao, string[]>> = {};

    for (const tipo of Object.keys(VENDOR_DA_CREDENCIAL) as TenantTokenKind[]) {
      // `SOFTRUCK_TOKEN` não é usado pela API da Softruck (ver
      // `CredenciaisSoftruck`): a falta dele não deixa a integração incompleta.
      if (tipo === 'softruck') continue;
      const nome = tenantEnvName(base, tipo);
      const presente =
        tipo === 'sgaBaseToken'
          ? [
              nome,
              ...Array.from(
                { length: MAX_TOKENS_BASE_SGA },
                (_, i) => `${nome}${i + 1}`,
              ),
            ].some((n) => !!valorDaEnvDeCredencial(n)?.trim())
          : !!valorDaEnvDeCredencial(nome);
      if (!presente) {
        (faltando[VENDOR_DA_CREDENCIAL[tipo]] ??= []).push(nome);
      }
    }
    return faltando;
  }
}
