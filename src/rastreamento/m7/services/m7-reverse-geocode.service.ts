import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { M7_GEOCODE_CONFIG } from 'src/config/m7-geocode.config';
import { PrismaService } from 'src/database/prisma.service';
import { baseTag } from 'src/shared/log.util';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { HistoricoM7ContestacaoPontoDto } from '../dto/historico-m7-response.dto';
import { calcularDistanciaMetros } from '../helpers/m7-gps-sanitizer.helper';
import { M7PontoHistoricoRaw } from '../interfaces/m7-historico.interface';
import { M7_REDIS } from '../providers/m7-redis.provider';

export type ReverseGeocodeItem = {
  key: string;
  latitude: string;
  longitude: string;
  cidade?: string;
};

/** Ponto do relatório de contestação já normalizado e com a chave de geocode (após herança). */
export interface PontoContestacaoNormalizado {
  placa: string;
  dataGps: string;
  velocidade: number;
  latitude: string;
  longitude: string;
  cidade: string;
  /** Chave "lat,lon" da âncora cujo endereço este ponto usa; '' se sem coordenada. */
  key: string;
}

/** Contadores de uma requisição de geocode (logados pelo serviço chamador). */
export interface EstatisticasGeocode {
  pontos: number;
  coordUnicas: number;
  ancoras: number;
  herdados: number;
  cacheMem: number;
  cacheRedis: number;
  geocodadas: number;
  semMatch: number;
  porOrcamento: number;
  redisIndisponivel: boolean;
}

/** Estado de uma requisição: orçamento de tempo, contadores e endereços já resolvidos. */
export interface ContextoGeocode {
  baseOrigin: BaseOrigin;
  inicioMs: number;
  budgetMs: number;
  estatisticas: EstatisticasGeocode;
  /** key da âncora → endereço (preenchido por Redis e pelo pool). */
  resolvidos: Map<string, string>;
}

export interface PreparoContestacao {
  pontos: PontoContestacaoNormalizado[];
  /** Âncoras em ordem de primeira ocorrência — as únicas coordenadas que vão ao cache/banco. */
  ancoras: ReverseGeocodeItem[];
  ancoraPorKey: Map<string, ReverseGeocodeItem>;
  estatisticas: EstatisticasGeocode;
}

type OrigemEndereco = 'memoria' | 'banco' | 'fallback';

type Ancora = {
  key: string;
  lat: number;
  lon: number;
  cidadeNorm: string;
};

const M7_NOMINATIM_DB = process.env.M7_NOMINATIM_DB ?? 'nominatim_rj';
const M7_NOMINATIM_TABLE = process.env.M7_NOMINATIM_TABLE ?? 'placex';
const M7_NOMINATIM_ENABLED =
  (process.env.M7_NOMINATIM_ENABLED ?? 'true').toLowerCase() !== 'false';

/** Prefixo das chaves no Redis; subir a versão invalida o cache inteiro. */
const REDIS_PREFIXO = 'm7:revgeo:v1';
/** Tamanho dos MGET/pipelines enviados ao Redis. */
const REDIS_LOTE = 1000;
/** Tempo máximo esperando o Redis antes de seguir só com o banco. */
const REDIS_TIMEOUT_MS = 1500;
/** Após uma falha, o Redis fica fora do caminho por este intervalo. */
const REDIS_CIRCUITO_ABERTO_MS = 60_000;
/** Célula da grade espacial usada na herança e na chave Redis (~11 m). */
const CELULA_FATOR = 10_000;

@Injectable()
export class M7ReverseGeocodeService {
  private readonly logger = new Logger(M7ReverseGeocodeService.name);
  private readonly reverseGeocodeCache = new Map<string, string>();
  private readonly reverseGeocodeInFlight = new Map<string, Promise<string>>();
  private redisIndisponivelAteMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(M7_REDIS) private readonly redis: Redis,
  ) {}

  normalizarCoordenada(valor: number | string | undefined): string | null {
    if (valor === null || valor === undefined) return null;

    const texto = String(valor).trim().replace(',', '.');
    if (!texto) return null;

    const numero = Number(texto);
    if (!Number.isFinite(numero)) return null;

    return numero.toFixed(6);
  }

  normalizarCidadeM7(cidade: string | undefined): string | null {
    if (!cidade?.trim()) return null;
    const nome = cidade.split(',')[0]?.trim();
    if (!nome) return null;

    const minusculas = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o']);

    return nome
      .toLowerCase()
      .split(' ')
      .map((palavra, index) =>
        index === 0 || !minusculas.has(palavra)
          ? palavra.charAt(0).toUpperCase() + palavra.slice(1)
          : palavra,
      )
      .join(' ');
  }

  montarChaveReverseGeocode(latitude: string, longitude: string): string {
    return `${latitude},${longitude}`;
  }

  /**
   * Resolve o endereço de uma coordenada (cache em memória → banco local → fallback
   * "lat, lon"). Assinatura mantida para os demais consumidores (viagens builder, Softruck).
   */
  async reverseGeocodeCoordenada(
    latitude: string,
    longitude: string,
    baseOrigin: BaseOrigin,
    cidadeOverride?: string,
  ): Promise<string> {
    const { endereco } = await this.resolverCoordenada(
      latitude,
      longitude,
      baseOrigin,
      cidadeOverride,
    );
    return endereco;
  }

  criarContexto(baseOrigin: BaseOrigin): ContextoGeocode {
    return {
      baseOrigin,
      inicioMs: Date.now(),
      budgetMs: M7_GEOCODE_CONFIG.budgetMs,
      estatisticas: {
        pontos: 0,
        coordUnicas: 0,
        ancoras: 0,
        herdados: 0,
        cacheMem: 0,
        cacheRedis: 0,
        geocodadas: 0,
        semMatch: 0,
        porOrcamento: 0,
        redisIndisponivel: false,
      },
      resolvidos: new Map<string, string>(),
    };
  }

  /**
   * Fluxo completo (usado pelo PDF de contestação V1): prepara, consulta o Redis,
   * resolve todas as âncoras e devolve os pontos com endereço.
   */
  async montarPontosContestacao(
    pontosRaw: M7PontoHistoricoRaw[],
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoM7ContestacaoPontoDto[]> {
    const contexto = this.criarContexto(baseOrigin);
    const preparo = this.prepararPontosContestacao(pontosRaw, contexto);

    await this.carregarCacheRedis(preparo.ancoras, contexto);
    await this.resolverEnderecos(preparo.ancoras, contexto);

    this.logger.debug(
      `${baseTag(baseOrigin)} contestação geocode ${this.formatarEstatisticas(contexto.estatisticas)}`,
    );

    return this.montarLinhasContestacao(preparo.pontos, contexto.resolvidos);
  }

  /**
   * Normaliza os pontos e aplica a herança espacial: um ponto a até
   * `herancaMetros` de uma âncora já vista (mesma cidade) reaproveita a chave
   * dela em vez de gerar um novo geocode. Ordem e quantidade de pontos são preservadas.
   */
  prepararPontosContestacao(
    pontosRaw: M7PontoHistoricoRaw[],
    contexto: ContextoGeocode,
  ): PreparoContestacao {
    const estatisticas = contexto.estatisticas;
    const herancaMetros = M7_GEOCODE_CONFIG.herancaMetros;

    const pontos: PontoContestacaoNormalizado[] = pontosRaw.map((ponto) => {
      const latitude = this.normalizarCoordenada(ponto.latitude) ?? '';
      const longitude = this.normalizarCoordenada(ponto.longitude) ?? '';

      return {
        placa: String(ponto.identificador ?? ''),
        dataGps: String(ponto.data_gps ?? ''),
        velocidade: Number(ponto.velocidade ?? 0) || 0,
        latitude,
        longitude,
        cidade: String(ponto.cidade ?? ''),
        key:
          latitude && longitude
            ? this.montarChaveReverseGeocode(latitude, longitude)
            : '',
      };
    });

    const ancoraPorKey = new Map<string, ReverseGeocodeItem>();
    const ancorasPorCelula = new Map<string, Ancora[]>();
    const coordUnicas = new Set<string>();

    for (const ponto of pontos) {
      if (!ponto.key) continue;
      coordUnicas.add(ponto.key);

      // Coordenada exatamente igual a uma âncora → mesmo comportamento de antes.
      if (ancoraPorKey.has(ponto.key)) continue;

      const lat = Number(ponto.latitude);
      const lon = Number(ponto.longitude);
      const cidadeNorm = this.normalizarCidadeM7(ponto.cidade) ?? '';

      if (herancaMetros > 0) {
        const ancora = this.buscarAncoraProxima(
          ancorasPorCelula,
          lat,
          lon,
          cidadeNorm,
          herancaMetros,
        );
        if (ancora) {
          ponto.key = ancora.key;
          estatisticas.herdados += 1;
          continue;
        }
      }

      ancoraPorKey.set(ponto.key, {
        key: ponto.key,
        latitude: ponto.latitude,
        longitude: ponto.longitude,
        cidade: ponto.cidade || undefined,
      });

      const celula = this.chaveCelula(lat, lon);
      const lista = ancorasPorCelula.get(celula);
      const nova: Ancora = { key: ponto.key, lat, lon, cidadeNorm };
      if (lista) lista.push(nova);
      else ancorasPorCelula.set(celula, [nova]);
    }

    estatisticas.pontos += pontos.length;
    estatisticas.coordUnicas += coordUnicas.size;
    estatisticas.ancoras += ancoraPorKey.size;

    return {
      pontos,
      ancoras: Array.from(ancoraPorKey.values()),
      ancoraPorKey,
      estatisticas,
    };
  }

  /**
   * Consulta o Redis para as âncoras ainda não resolvidas (MGET em lotes),
   * renova o TTL dos hits e registra os endereços em `contexto.resolvidos`.
   * Redis indisponível nunca falha a requisição: apenas segue para o banco.
   */
  async carregarCacheRedis(
    ancoras: ReverseGeocodeItem[],
    contexto: ContextoGeocode,
  ): Promise<number> {
    const pendentes = ancoras.filter((a) => !contexto.resolvidos.has(a.key));
    if (!pendentes.length || !this.redisDisponivel()) {
      if (pendentes.length) contexto.estatisticas.redisIndisponivel = true;
      return 0;
    }

    let hits = 0;
    try {
      for (let i = 0; i < pendentes.length; i += REDIS_LOTE) {
        const lote = pendentes.slice(i, i + REDIS_LOTE);
        const chaves = lote.map((a) => this.chaveRedis(a));
        const valores = await this.comTimeout(
          this.redis.mget(...chaves),
          REDIS_TIMEOUT_MS,
        );

        const renovar = this.redis.pipeline();
        valores.forEach((valor, idx) => {
          if (!valor) return;
          contexto.resolvidos.set(lote[idx].key, valor);
          renovar.expire(chaves[idx], M7_GEOCODE_CONFIG.redisTtlSeg);
          hits += 1;
        });
        if (hits) {
          void renovar.exec().catch(() => undefined);
        }
      }
    } catch (error) {
      this.marcarRedisIndisponivel(contexto, error);
    }

    contexto.estatisticas.cacheRedis += hits;
    return hits;
  }

  /**
   * Resolve as âncoras pendentes com um pool de N workers (sem head-of-line
   * blocking entre lotes). Respeita o orçamento de tempo do contexto e persiste
   * no Redis apenas endereços vindos do banco (nunca o fallback "lat, lon").
   */
  async resolverEnderecos(
    itens: ReverseGeocodeItem[],
    contexto: ContextoGeocode,
  ): Promise<void> {
    const vistos = new Set<string>();
    const pendentes: ReverseGeocodeItem[] = [];
    for (const item of itens) {
      if (contexto.resolvidos.has(item.key) || vistos.has(item.key)) continue;
      vistos.add(item.key);
      pendentes.push(item);
    }
    if (!pendentes.length) return;

    const estatisticas = contexto.estatisticas;
    const paraRedis: Array<{ item: ReverseGeocodeItem; endereco: string }> = [];
    let proximo = 0;

    const worker = async (): Promise<void> => {
      while (proximo < pendentes.length) {
        const item = pendentes[proximo++];

        if (Date.now() - contexto.inicioMs > contexto.budgetMs) {
          contexto.resolvidos.set(
            item.key,
            `${item.latitude}, ${item.longitude}`,
          );
          estatisticas.porOrcamento += 1;
          continue;
        }

        const cidadeOverride = item.cidade
          ? (this.normalizarCidadeM7(item.cidade) ?? undefined)
          : undefined;

        try {
          const { endereco, origem } = await this.resolverCoordenada(
            item.latitude,
            item.longitude,
            contexto.baseOrigin,
            cidadeOverride,
          );
          contexto.resolvidos.set(item.key, endereco);

          if (origem === 'memoria') estatisticas.cacheMem += 1;
          else if (origem === 'banco') {
            estatisticas.geocodadas += 1;
            paraRedis.push({ item, endereco });
          } else estatisticas.semMatch += 1;
        } catch (error) {
          contexto.resolvidos.set(
            item.key,
            `${item.latitude}, ${item.longitude}`,
          );
          estatisticas.semMatch += 1;
          this.logger.warn(
            `${baseTag(contexto.baseOrigin)} reverse geocode falhou para ${item.key}: ${
              error instanceof Error ? error.message : 'erro desconhecido'
            }`,
          );
        }
      }
    };

    const workers = Math.min(M7_GEOCODE_CONFIG.concorrencia, pendentes.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));

    if (estatisticas.porOrcamento > 0) {
      this.logger.warn(
        `${baseTag(contexto.baseOrigin)} orçamento de geocode (${contexto.budgetMs} ms) excedido: ${estatisticas.porOrcamento} coordenada(s) com fallback de coordenadas`,
      );
    }

    this.persistirRedis(paraRedis, contexto);
  }

  montarLinhasContestacao(
    pontos: PontoContestacaoNormalizado[],
    resolvidos: Map<string, string>,
  ): HistoricoM7ContestacaoPontoDto[] {
    return pontos.map((item) => ({
      placa: item.placa,
      dataGps: item.dataGps,
      velocidade: item.velocidade,
      latitude: item.latitude,
      longitude: item.longitude,
      endereco:
        item.key && resolvidos.get(item.key)
          ? resolvidos.get(item.key)!
          : item.latitude && item.longitude
            ? `${item.latitude}, ${item.longitude}`
            : '',
    }));
  }

  formatarEstatisticas(e: EstatisticasGeocode): string {
    return (
      `pontos=${e.pontos} coordUnicas=${e.coordUnicas} ancoras=${e.ancoras} herdados=${e.herdados} ` +
      `cacheMem=${e.cacheMem} cacheRedis=${e.cacheRedis} geocodadas=${e.geocodadas} ` +
      `semMatch=${e.semMatch} porOrcamento=${e.porOrcamento}` +
      (e.redisIndisponivel ? ' redis=indisponivel' : '')
    );
  }

  // ---------------------------------------------------------------------------
  // Internos: cache em memória, herança, Redis
  // ---------------------------------------------------------------------------

  private async resolverCoordenada(
    latitude: string,
    longitude: string,
    baseOrigin: BaseOrigin,
    cidadeOverride?: string,
  ): Promise<{ endereco: string; origem: OrigemEndereco }> {
    // A chave inclui o override de cidade: o endereço depende dele, e sem isso
    // o cache era ignorado em todo ponto M7 (que sempre traz `cidade`).
    const key = `${this.montarChaveReverseGeocode(latitude, longitude)}|${cidadeOverride ?? ''}`;

    const cached = this.lerMemoria(key);
    if (cached) return { endereco: cached, origem: 'memoria' };

    const inFlight = this.reverseGeocodeInFlight.get(key);
    if (inFlight) {
      return { endereco: await inFlight, origem: 'memoria' };
    }

    let origem: OrigemEndereco = 'banco';
    const promise = (async () => {
      const enderecoNominatimMysql =
        await this.buscarReverseGeocodeNominatimMysql(
          latitude,
          longitude,
          baseOrigin,
          cidadeOverride,
        );
      if (enderecoNominatimMysql) {
        this.guardarMemoria(key, enderecoNominatimMysql);
        return enderecoNominatimMysql;
      }

      origem = 'fallback';
      this.logger.warn(
        `${baseTag(baseOrigin)} reverse geocode sem correspondência local para ${latitude},${longitude}; usando fallback de coordenadas`,
      );

      const fallback = `${latitude}, ${longitude}`;
      this.guardarMemoria(key, fallback);
      return fallback;
    })().finally(() => {
      this.reverseGeocodeInFlight.delete(key);
    });

    this.reverseGeocodeInFlight.set(key, promise);
    const endereco = await promise;
    return { endereco, origem };
  }

  private lerMemoria(key: string): string | undefined {
    const valor = this.reverseGeocodeCache.get(key);
    if (valor === undefined) return undefined;
    // Reinsere para manter a ordem de uso (LRU simples sobre Map).
    this.reverseGeocodeCache.delete(key);
    this.reverseGeocodeCache.set(key, valor);
    return valor;
  }

  private guardarMemoria(key: string, valor: string): void {
    if (this.reverseGeocodeCache.size >= M7_GEOCODE_CONFIG.memCacheMax) {
      const maisAntiga = this.reverseGeocodeCache.keys().next().value as
        | string
        | undefined;
      if (maisAntiga !== undefined) this.reverseGeocodeCache.delete(maisAntiga);
    }
    this.reverseGeocodeCache.set(key, valor);
  }

  private chaveCelula(lat: number, lon: number): string {
    return `${Math.round(lat * CELULA_FATOR)},${Math.round(lon * CELULA_FATOR)}`;
  }

  private buscarAncoraProxima(
    ancorasPorCelula: Map<string, Ancora[]>,
    lat: number,
    lon: number,
    cidadeNorm: string,
    maxMetros: number,
  ): Ancora | null {
    const cLat = Math.round(lat * CELULA_FATOR);
    const cLon = Math.round(lon * CELULA_FATOR);
    let melhor: Ancora | null = null;
    let melhorDist = Number.POSITIVE_INFINITY;

    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const lista = ancorasPorCelula.get(`${cLat + dLat},${cLon + dLon}`);
        if (!lista) continue;
        for (const ancora of lista) {
          if (ancora.cidadeNorm !== cidadeNorm) continue;
          const dist = calcularDistanciaMetros(
            ancora.lat,
            ancora.lon,
            lat,
            lon,
          );
          if (dist <= maxMetros && dist < melhorDist) {
            melhor = ancora;
            melhorDist = dist;
          }
        }
      }
    }

    return melhor;
  }

  private chaveRedis(item: ReverseGeocodeItem): string {
    const lat = Math.round(Number(item.latitude) * CELULA_FATOR);
    const lon = Math.round(Number(item.longitude) * CELULA_FATOR);
    const cidade = (this.normalizarCidadeM7(item.cidade) ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    return `${REDIS_PREFIXO}:${lat}:${lon}:${cidade}`;
  }

  private persistirRedis(
    entradas: Array<{ item: ReverseGeocodeItem; endereco: string }>,
    contexto: ContextoGeocode,
  ): void {
    if (!entradas.length || !this.redisDisponivel()) return;

    // Fora do caminho crítico: a resposta não espera a gravação.
    void (async () => {
      try {
        for (let i = 0; i < entradas.length; i += REDIS_LOTE) {
          const pipeline = this.redis.pipeline();
          for (const { item, endereco } of entradas.slice(i, i + REDIS_LOTE)) {
            pipeline.set(
              this.chaveRedis(item),
              endereco,
              'EX',
              M7_GEOCODE_CONFIG.redisTtlSeg,
            );
          }
          await this.comTimeout(pipeline.exec(), REDIS_TIMEOUT_MS * 2);
        }
      } catch (error) {
        this.marcarRedisIndisponivel(contexto, error);
      }
    })();
  }

  private redisDisponivel(): boolean {
    return Date.now() >= this.redisIndisponivelAteMs;
  }

  private marcarRedisIndisponivel(
    contexto: ContextoGeocode,
    error: unknown,
  ): void {
    this.redisIndisponivelAteMs = Date.now() + REDIS_CIRCUITO_ABERTO_MS;
    contexto.estatisticas.redisIndisponivel = true;
    this.logger.warn(
      `${baseTag(contexto.baseOrigin)} cache Redis de reverse geocode indisponível (${
        error instanceof Error ? error.message : 'erro desconhecido'
      }); seguindo só com o banco por ${REDIS_CIRCUITO_ABERTO_MS / 1000}s`,
    );
  }

  private comTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout após ${ms} ms`)),
        ms,
      );
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private sanitizarSqlIdentifier(value: string, fallback: string): string {
    return /^[A-Za-z0-9_]+$/.test(value) ? value : fallback;
  }

  // ---------------------------------------------------------------------------
  // Algoritmo de geocoding (intocado)
  // ---------------------------------------------------------------------------

  private async buscarReverseGeocodeNominatimMysql(
    latitude: string,
    longitude: string,
    baseOrigin: BaseOrigin,
    cidadeOverride?: string,
  ): Promise<string | null> {
    if (!M7_NOMINATIM_ENABLED) return null;

    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const db = this.sanitizarSqlIdentifier(M7_NOMINATIM_DB, 'nominatim_rj');
    const tbl = this.sanitizarSqlIdentifier(M7_NOMINATIM_TABLE, 'placex');

    const R_STREET = 0.005;
    const R_SUBURB = 0.03;
    const R_CITY = 0.5;

    type PlacexRow = {
      name: string | null;
      name_pt: string | null;
      type: string | null;
      postcode: string | null;
      admin_level: number | null;
      address_suburb?: string | null;
      address_city?: string | null;
    };

    const runQuery = async (
      rLat: number,
      rLon: number,
      extraWhere: string,
      limit: number,
    ): Promise<PlacexRow[]> => {
      const dist = `((latitude-(${lat}))*(latitude-(${lat}))+(longitude-(${lon}))*(longitude-(${lon})))`;
      const cols =
        'name, name_pt, type, postcode, admin_level, address_suburb, address_city';
      const sqls = [
        `SELECT ${cols} FROM \`${db}\`.\`${tbl}\` WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${extraWhere} ORDER BY ${dist} ASC LIMIT ${limit}`,
        `SELECT ${cols} FROM \`${tbl}\` WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${extraWhere} ORDER BY ${dist} ASC LIMIT ${limit}`,
      ];

      for (const sql of sqls) {
        try {
          const rows = await this.prisma.$queryRawUnsafe<PlacexRow[]>(
            sql,
            lat - rLat,
            lat + rLat,
            lon - rLon,
            lon + rLon,
          );
          if (Array.isArray(rows) && rows.length) return rows;
        } catch {
          // tenta sem prefixo de banco
        }
      }

      return [];
    };

    const pickName = (row: PlacexRow): string | null => {
      const value = row.name_pt ?? row.name;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };

    const pickAddressComponent = (
      ...values: Array<string | null | undefined>
    ): string | null => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return null;
    };

    try {
      const [ruasRows, bairroRows, cidadeRows] = await Promise.all([
        runQuery(R_STREET, R_STREET, ` AND class = 'highway'`, 3),
        runQuery(
          R_SUBURB,
          R_SUBURB,
          ` AND class = 'place' AND type IN ('quarter','neighbourhood','suburb')`,
          5,
        ),
        runQuery(
          R_CITY,
          R_CITY,
          ` AND class = 'boundary' AND type = 'administrative' AND admin_level = 8`,
          1,
        ),
      ]);

      const ruaRow = ruasRows[0] ?? null;
      const rua = ruaRow ? pickName(ruaRow) : null;
      const bairroRow =
        bairroRows.find((row) => row.type === 'quarter') ??
        bairroRows.find((row) => row.type === 'neighbourhood') ??
        bairroRows.find((row) => row.type === 'suburb') ??
        bairroRows[0] ??
        null;
      const bairro =
        pickAddressComponent(ruaRow?.address_suburb) ??
        (bairroRow ? pickName(bairroRow) : null);
      const cidade =
        cidadeOverride ??
        pickAddressComponent(ruaRow?.address_city) ??
        (cidadeRows.length ? pickName(cidadeRows[0]) : null) ??
        'Rio de Janeiro';

      let numeroPredial: string | null = null;
      if (rua) {
        const R_HOUSE = 0.0005;
        const distExpr = `((latitude-(${lat}))*(latitude-(${lat}))+(longitude-(${lon}))*(longitude-(${lon})))`;
        const houseCols = 'housenumber, latitude, longitude';

        const bairroFilter = bairro
          ? ` AND (address_suburb = ? OR address_suburb IS NULL)`
          : '';
        const whereHouse =
          ` AND housenumber IS NOT NULL` +
          ` AND address_street = ?` +
          ` AND (address_city = ? OR address_city IS NULL)` +
          bairroFilter;

        const houseParams: unknown[] = bairro
          ? [
              lat - R_HOUSE,
              lat + R_HOUSE,
              lon - R_HOUSE,
              lon + R_HOUSE,
              rua,
              cidade,
              bairro,
            ]
          : [
              lat - R_HOUSE,
              lat + R_HOUSE,
              lon - R_HOUSE,
              lon + R_HOUSE,
              rua,
              cidade,
            ];

        const houseSqls = [
          `SELECT ${houseCols} FROM \`${db}\`.\`${tbl}\` WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${whereHouse} ORDER BY ${distExpr} ASC LIMIT 3`,
          `SELECT ${houseCols} FROM \`${tbl}\` WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${whereHouse} ORDER BY ${distExpr} ASC LIMIT 3`,
        ];

        type HouseRow = {
          housenumber: string | null;
          latitude: number | string | null;
          longitude: number | string | null;
        };

        for (const hsql of houseSqls) {
          try {
            const houseRows = await this.prisma.$queryRawUnsafe<HouseRow[]>(
              hsql,
              ...houseParams,
            );
            if (Array.isArray(houseRows) && houseRows.length) {
              const chosen = houseRows[0];
              numeroPredial =
                typeof chosen.housenumber === 'string' &&
                chosen.housenumber.trim()
                  ? chosen.housenumber.trim()
                  : null;

              if (numeroPredial) {
                const distApprox = Math.round(
                  Math.sqrt(
                    (Number(chosen.latitude) - lat) ** 2 +
                      (Number(chosen.longitude) - lon) ** 2,
                  ) * 111_000,
                );
                this.logger.debug(
                  `[${baseOrigin}] housenumber | rua="${rua}" imóveis=${houseRows.length} número="${numeroPredial}" dist≈${distApprox}m`,
                );
              }
              break;
            }
          } catch {
            // coluna address_street pode não existir - ignora silenciosamente
          }
        }
      }

      const partes: string[] = [];
      if (rua) {
        partes.push(numeroPredial ? `${rua}, ${numeroPredial}` : rua);
      }
      if (bairro) partes.push(bairro);
      partes.push(cidade);
      partes.push('RJ');

      if (rua || bairro) {
        const endereco = partes.join(', ');
        return endereco;
      }
    } catch (error) {
      this.logger.warn(
        `[${baseOrigin}] falha consulta nominatim_rj para ${latitude},${longitude}: ${
          error instanceof Error ? error.message : 'erro desconhecido'
        }`,
      );
    }

    return null;
  }
}
