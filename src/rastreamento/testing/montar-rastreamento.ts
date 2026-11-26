import { CacheService } from 'src/infra/cache/cache.service';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';
import { ResultadoDaTrava, TravaService } from 'src/infra/redis/trava.service';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { ProvedorLogica } from 'src/rastreamento/logica/services/logica-provedor';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';
import { M7AuthService } from 'src/rastreamento/m7/services/m7-auth.service';
import { ProvedorM7 } from 'src/rastreamento/m7/services/m7-provedor';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { ProvedorDeRastreamento } from 'src/rastreamento/providers/rastreamento-provider.interface';
import { EventoWebhookRepository } from 'src/rastreamento/repositories/evento-webhook.repository';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';
import { ComandosVeiculoService } from 'src/rastreamento/services/comandos-veiculo.service';
import { ConsultarPosicaoService } from 'src/rastreamento/services/consultar-posicao.service';
import { ConsultasPorProvedorService } from 'src/rastreamento/services/consultas-por-provedor.service';
import { ProcessarWebhookM7Service } from 'src/rastreamento/services/processar-webhook-m7.service';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { HistoricoSoftruckService } from 'src/rastreamento/softruck/services/historico-softruck.service';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { SoftruckCredenciais } from 'src/rastreamento/softruck/services/softruck-credenciais';
import { ProvedorSoftruck } from 'src/rastreamento/softruck/services/softruck-provedor';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * Credenciais fictícias das duas bases padrão (`MAIS_PRIME`, sem sufixo, e
 * `MAIS_PRIME_RS`, sufixo `_RS`). Devolve a função que restaura o ambiente.
 */
export function prepararCredenciaisDeTeste(
  semCredencial: string[] = [],
): () => void {
  const original = { ...process.env };
  const valores: Record<string, string> = {
    MO7_TOKEN: 'm7-token',
    M07_CODIGO: 'm7-codigo',
    LOGICA_TOKEN: 'logica-token',
    USERNAME_SOFTRUCK: 'softruck-usuario',
    PASSWORD_SOFTRUCK: 'softruck-senha',
    PUBLIC_KEY_SOFTRUCK: 'softruck-key',
  };
  for (const [nome, valor] of Object.entries(valores)) {
    process.env[nome] = valor;
    process.env[`${nome}_RS`] = valor;
  }
  for (const nome of semCredencial) delete process.env[nome];
  return () => {
    process.env = { ...original };
  };
}

/** Trava que sempre é obtida: o comando roda na hora. */
export class TravaLivre {
  chaves: string[] = [];

  async tentar<T>(
    chave: string,
    _ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<ResultadoDaTrava<T>> {
    this.chaves.push(chave);
    return { executou: true, valor: await fn() };
  }
}

export interface DublesDoRastreamento {
  banco: BancoRastreamentoEmMemoria;
  m7: unknown;
  logica: unknown;
  softruck: unknown;
  historicoSoftruck?: unknown;
  reverseGeocode?: unknown;
  notifications?: unknown;
  trava?: unknown;
  cache?: CacheService;
}

/**
 * Monta o rastreamento inteiro (fachada + casos de uso + repositórios +
 * provedores de verdade) sobre os dublês dos CLIENTS de vendor, do banco e do
 * Redis. Único lugar dos specs que conhece a estrutura interna do módulo.
 */
export function montarRastreamento(dubles: DublesDoRastreamento) {
  const registry = new TenantCredentialsRegistry();
  const veiculos = new VeiculoRastreamentoRepository(dubles.banco.prisma);
  const eventos = new EventoWebhookRepository(dubles.banco.prisma);
  const cache =
    dubles.cache ?? new CacheService(new RedisEmMemoria().comoRedis());
  const trava = (dubles.trava ?? new TravaLivre()) as TravaService;

  const m7 = dubles.m7 as RastreamentoM7;
  const logica = dubles.logica as LogicaRastreamentoService;
  const softruck = dubles.softruck as RastreamentoSoftruck;
  const reverseGeocode = (dubles.reverseGeocode ??
    {}) as M7ReverseGeocodeService;

  const provedorLogica = new ProvedorLogica(logica, registry);
  const softruckCredenciais = new SoftruckCredenciais(registry);
  const provedores: ProvedorDeRastreamento[] = [
    provedorLogica,
    new ProvedorM7(
      m7,
      new M7AuthService(registry, VendorSessionStore.emMemoria()),
    ),
    new ProvedorSoftruck(softruck, softruckCredenciais, reverseGeocode),
  ];

  const posicao = new ConsultarPosicaoService(provedores, veiculos, cache);
  const comandos = new ComandosVeiculoService(veiculos, m7, trava);
  const webhook = new ProcessarWebhookM7Service(
    eventos,
    veiculos,
    (dubles.notifications ?? {}) as NotificationsService,
    m7,
    trava,
  );
  const porProvedor = new ConsultasPorProvedorService(
    veiculos,
    m7,
    logica,
    provedorLogica,
    softruck,
    softruckCredenciais,
    (dubles.historicoSoftruck ?? {}) as HistoricoSoftruckService,
  );

  return {
    service: new RastreamentoService(posicao, comandos, webhook, porProvedor),
    posicao,
    comandos,
    webhook,
    veiculos,
    eventos,
    cache,
    provedores,
  };
}
