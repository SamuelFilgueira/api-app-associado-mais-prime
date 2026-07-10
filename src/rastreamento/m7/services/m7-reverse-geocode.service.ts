import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { HistoricoM7ContestacaoPontoDto } from '../dto/historico-m7-response.dto';
import { M7PontoHistoricoRaw } from '../interfaces/m7-historico.interface';

type ReverseGeocodeItem = {
  key: string;
  latitude: string;
  longitude: string;
  cidade?: string;
};

const M7_REV_GEOCODE_CONCURRENCY_RAW = Number(
  process.env.M7_REV_GEOCODE_CONCURRENCY ?? 16,
);
const M7_REV_GEOCODE_CONCURRENCY = Number.isFinite(
  M7_REV_GEOCODE_CONCURRENCY_RAW,
)
  ? Math.max(1, Math.min(64, Math.trunc(M7_REV_GEOCODE_CONCURRENCY_RAW)))
  : 16;
const M7_REV_GEOCODE_CACHE_PROVIDERS = (
  process.env.M7_REV_GEOCODE_CACHE_PROVIDERS ??
  'osm_rj,external_reverse_geocode'
)
  .split(',')
  .map((provider) => provider.trim())
  .filter(Boolean);
const M7_REV_GEOCODE_CACHE_RADIUS_KEYS = Number(
  process.env.M7_REV_GEOCODE_CACHE_RADIUS_KEYS ?? 30,
);
const M7_NOMINATIM_DB = process.env.M7_NOMINATIM_DB ?? 'nominatim_rj';
const M7_NOMINATIM_TABLE = process.env.M7_NOMINATIM_TABLE ?? 'placex';
const M7_NOMINATIM_ENABLED =
  (process.env.M7_NOMINATIM_ENABLED ?? 'true').toLowerCase() !== 'false';
const M7_NOMINATIM_AUTO_ENSURE_INDEXES =
  (process.env.M7_NOMINATIM_AUTO_ENSURE_INDEXES ?? 'true').toLowerCase() !==
  'false';
const M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK = (
  process.env.M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK ?? 'false'
).toLowerCase() === 'true';

type NominatimSqlMode = 'db_prefixed' | 'table_only';

@Injectable()
export class M7ReverseGeocodeService {
  private readonly logger = new Logger(M7ReverseGeocodeService.name);
  private readonly reverseGeocodeCache = new Map<string, string>();
  private readonly reverseGeocodeInFlight = new Map<string, Promise<string>>();
  private nominatimSqlMode: NominatimSqlMode = 'db_prefixed';
  private nominatimFallbackModeWarned = false;
  private nominatimIndexesBootstrapPromise: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

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

  async reverseGeocodeCoordenada(
    latitude: string,
    longitude: string,
    baseOrigin: BaseOrigin,
    cidadeOverride?: string,
  ): Promise<string> {
    const key = this.montarChaveReverseGeocode(latitude, longitude);

    const cached = this.reverseGeocodeCache.get(key);
    if (cached && !cidadeOverride) return cached;

    const inFlight = this.reverseGeocodeInFlight.get(key);
    if (inFlight && !cidadeOverride) return inFlight;

    const promise = (async () => {
      const enderecoNominatimMysql =
        await this.buscarReverseGeocodeNominatimMysql(
          latitude,
          longitude,
          baseOrigin,
          cidadeOverride,
        );
      if (enderecoNominatimMysql) {
        this.reverseGeocodeCache.set(key, enderecoNominatimMysql);
        return enderecoNominatimMysql;
      }

      if (M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK) {
        const enderecoCacheMysql = await this.buscarReverseGeocodeCacheMysql(
          latitude,
          longitude,
          baseOrigin,
        );
        if (enderecoCacheMysql) {
          this.reverseGeocodeCache.set(key, enderecoCacheMysql);
          return enderecoCacheMysql;
        }
      }

      this.logger.warn(
        `[${baseOrigin}] reverse geocode sem correspondência local para ${key}; usando fallback de coordenadas`,
      );

      const fallback = `${latitude}, ${longitude}`;
      this.reverseGeocodeCache.set(key, fallback);
      return fallback;
    })().finally(() => {
      this.reverseGeocodeInFlight.delete(key);
    });

    this.reverseGeocodeInFlight.set(key, promise);
    return promise;
  }

  async montarPontosContestacao(
    pontosRaw: M7PontoHistoricoRaw[],
    baseOrigin: BaseOrigin,
  ): Promise<HistoricoM7ContestacaoPontoDto[]> {
    const normalizados = pontosRaw.map((ponto) => {
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

    const mapaUnicos = new Map<string, ReverseGeocodeItem>();
    for (const item of normalizados) {
      if (!item.key) continue;
      if (!mapaUnicos.has(item.key)) {
        mapaUnicos.set(item.key, {
          key: item.key,
          latitude: item.latitude,
          longitude: item.longitude,
          cidade: item.cidade || undefined,
        });
      }
    }

    const enderecoPorCoordenada = await this.reverseGeocodeEmLote(
      Array.from(mapaUnicos.values()),
      baseOrigin,
    );

    return normalizados.map((item) => ({
      placa: item.placa,
      dataGps: item.dataGps,
      velocidade: item.velocidade,
      latitude: item.latitude,
      longitude: item.longitude,
      endereco:
        item.key && enderecoPorCoordenada.get(item.key)
          ? enderecoPorCoordenada.get(item.key)!
          : item.latitude && item.longitude
            ? `${item.latitude}, ${item.longitude}`
            : '',
    }));
  }

  private montarChaveCacheCoordenada(coordenada: string): number {
    return Math.round(Number(coordenada) * 100_000);
  }

  private sanitizarSqlIdentifier(value: string, fallback: string): string {
    return /^[A-Za-z0-9_]+$/.test(value) ? value : fallback;
  }

  private async reverseGeocodeEmLote(
    items: ReverseGeocodeItem[],
    baseOrigin: BaseOrigin,
  ): Promise<Map<string, string>> {
    if (M7_NOMINATIM_ENABLED && M7_NOMINATIM_AUTO_ENSURE_INDEXES) {
      this.dispararBootstrapIndicesNominatim();
    }

    const resultado = new Map<string, string>();

    for (
      let inicio = 0;
      inicio < items.length;
      inicio += M7_REV_GEOCODE_CONCURRENCY
    ) {
      const lote = items.slice(inicio, inicio + M7_REV_GEOCODE_CONCURRENCY);
      await Promise.all(
        lote.map(async (item) => {
          const cidadeOverride = item.cidade
            ? (this.normalizarCidadeM7(item.cidade) ?? undefined)
            : undefined;
          const endereco = await this.reverseGeocodeCoordenada(
            item.latitude,
            item.longitude,
            baseOrigin,
            cidadeOverride,
          );
          resultado.set(item.key, endereco);
        }),
      );
    }

    return resultado;
  }

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
      const sqlComDb =
        `SELECT ${cols} FROM \`${db}\`.\`${tbl}\` ` +
        `WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${extraWhere} ` +
        `ORDER BY ${dist} ASC LIMIT ${limit}`;
      const sqlSemDb =
        `SELECT ${cols} FROM \`${tbl}\` ` +
        `WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${extraWhere} ` +
        `ORDER BY ${dist} ASC LIMIT ${limit}`;

      return this.executarQueryNominatimComFallback<PlacexRow>(
        sqlComDb,
        sqlSemDb,
        [lat - rLat, lat + rLat, lon - rLon, lon + rLon],
      );
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

        try {
          const houseRows = await this.executarQueryNominatimComFallback<HouseRow>(
            houseSqls[0],
            houseSqls[1],
            houseParams,
          );

          if (houseRows.length) {
            const chosen = houseRows[0];
            numeroPredial =
              typeof chosen.housenumber === 'string' && chosen.housenumber.trim()
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
          }
        } catch {
          // coluna address_street pode não existir - ignora silenciosamente
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
        this.logger.debug(
          `[${baseOrigin}] nominatim_rj hit ${latitude},${longitude} → ${endereco}`,
        );
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

  private dispararBootstrapIndicesNominatim() {
    if (!this.nominatimIndexesBootstrapPromise) {
      this.nominatimIndexesBootstrapPromise = this.assegurarIndicesNominatim();
    }
  }

  private async executarQueryNominatimComFallback<T>(
    sqlComDb: string,
    sqlSemDb: string,
    params: unknown[],
  ): Promise<T[]> {
    if (this.nominatimSqlMode === 'table_only') {
      try {
        const rows = await this.prisma.$queryRawUnsafe<T[]>(sqlSemDb, ...params);
        if (Array.isArray(rows)) return rows;
      } catch {
        // tenta restabelecer modo com prefixo de DB
      }

      try {
        const rows = await this.prisma.$queryRawUnsafe<T[]>(sqlComDb, ...params);
        this.nominatimSqlMode = 'db_prefixed';
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    }

    try {
      const rows = await this.prisma.$queryRawUnsafe<T[]>(sqlComDb, ...params);
      return Array.isArray(rows) ? rows : [];
    } catch {
      try {
        const rows = await this.prisma.$queryRawUnsafe<T[]>(sqlSemDb, ...params);
        if (!this.nominatimFallbackModeWarned) {
          this.logger.warn(
            'nominatim_rj com prefixo de banco indisponivel; usando tabela sem prefixo para reduzir latencia de fallback',
          );
          this.nominatimFallbackModeWarned = true;
        }
        this.nominatimSqlMode = 'table_only';
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    }
  }

  private async assegurarIndicesNominatim(): Promise<void> {
    const db = this.sanitizarSqlIdentifier(M7_NOMINATIM_DB, 'nominatim_rj');
    const tbl = this.sanitizarSqlIdentifier(M7_NOMINATIM_TABLE, 'placex');

    type ColumnRow = { COLUMN_NAME: string };
    type IndexRow = { INDEX_NAME: string };

    try {
      const colunas = await this.prisma.$queryRawUnsafe<ColumnRow[]>(
        'SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
        db,
        tbl,
      );
      const colunasSet = new Set(
        (Array.isArray(colunas) ? colunas : []).map((item) => item.COLUMN_NAME),
      );

      if (!colunasSet.size) {
        this.logger.warn(
          `nominatim_rj index bootstrap ignorado: tabela ${db}.${tbl} nao encontrada`,
        );
        return;
      }

      const indices = await this.prisma.$queryRawUnsafe<IndexRow[]>(
        'SELECT DISTINCT INDEX_NAME FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?',
        db,
        tbl,
      );
      const indicesSet = new Set(
        (Array.isArray(indices) ? indices : []).map((item) => item.INDEX_NAME),
      );

      const criarIndiceSeNecessario = async (
        nomeIndice: string,
        sql: string,
        colunasObrigatorias: string[],
      ) => {
        if (indicesSet.has(nomeIndice)) return;
        if (!colunasObrigatorias.every((coluna) => colunasSet.has(coluna))) {
          return;
        }

        await this.prisma.$executeRawUnsafe(sql);
        indicesSet.add(nomeIndice);
      };

      await criarIndiceSeNecessario(
        'idx_m7_plx_class_lat_lng',
        `CREATE INDEX idx_m7_plx_class_lat_lng ON \`${db}\`.\`${tbl}\` (\`class\`, \`latitude\`, \`longitude\`)`,
        ['class', 'latitude', 'longitude'],
      );

      await criarIndiceSeNecessario(
        'idx_m7_plx_class_type_lat_lng',
        `CREATE INDEX idx_m7_plx_class_type_lat_lng ON \`${db}\`.\`${tbl}\` (\`class\`, \`type\`, \`latitude\`, \`longitude\`)`,
        ['class', 'type', 'latitude', 'longitude'],
      );

      await criarIndiceSeNecessario(
        'idx_m7_plx_cls_type_admin_lat_lng',
        `CREATE INDEX idx_m7_plx_cls_type_admin_lat_lng ON \`${db}\`.\`${tbl}\` (\`class\`, \`type\`, \`admin_level\`, \`latitude\`, \`longitude\`)`,
        ['class', 'type', 'admin_level', 'latitude', 'longitude'],
      );

      await criarIndiceSeNecessario(
        'idx_m7_plx_house_lookup',
        `CREATE INDEX idx_m7_plx_house_lookup ON \`${db}\`.\`${tbl}\` (\`address_street\`(120), \`address_city\`(80), \`address_suburb\`(80), \`housenumber\`(20), \`latitude\`, \`longitude\`)`,
        [
          'address_street',
          'address_city',
          'address_suburb',
          'housenumber',
          'latitude',
          'longitude',
        ],
      );
    } catch (error) {
      this.logger.warn(
        `nominatim_rj index bootstrap falhou: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
      );
    }
  }

  // private async buscarReverseGeocodeCacheMysql(
  //   latitude: string,
  //   longitude: string,
  //   baseOrigin: BaseOrigin,
  // ): Promise<string | null> {
  //   const latKey = this.montarChaveCacheCoordenada(latitude);
  //   const lngKey = this.montarChaveCacheCoordenada(longitude);
  //   const radius = Number.isFinite(M7_REV_GEOCODE_CACHE_RADIUS_KEYS)
  //     ? Math.max(0, M7_REV_GEOCODE_CACHE_RADIUS_KEYS)
  //     : 30;

  //   try {
  //     const registros = await this.prisma.reverse_geocode_cache.findMany({
  //       where: {
  //         provider: { in: M7_REV_GEOCODE_CACHE_PROVIDERS },
  //         lat_key: { gte: latKey - radius, lte: latKey + radius },
  //         lng_key: { gte: lngKey - radius, lte: lngKey + radius },
  //       },
  //       select: {
  //         address: true,
  //         latitude: true,
  //         longitude: true,
  //         confidence: true,
  //       },
  //       take: 50,
  //     });

  //     if (!registros.length) return null;

  //     const latitudeNumero = Number(latitude);
  //     const longitudeNumero = Number(longitude);
  //     const melhor = registros
  //       .map((registro) => {
  //         const diffLat = Number(registro.latitude) - latitudeNumero;
  //         const diffLng = Number(registro.longitude) - longitudeNumero;

  //         return {
  //           address: registro.address,
  //           confidence: registro.confidence,
  //           distance: diffLat * diffLat + diffLng * diffLng,
  //         };
  //       })
  //       .sort((a, b) => a.distance - b.distance)[0];

  //     if (!melhor?.address) return null;

  //     this.logger.debug(
  //       `[${baseOrigin}] reverse geocode cache MySQL hit para ${latitude},${longitude} (${melhor.confidence})`,
  //     );
  //     return melhor.address;
  //   } catch (error) {
  //     this.logger.warn(
  //       `[${baseOrigin}] reverse geocode cache MySQL indisponível para ${latitude},${longitude}: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
  //     );
  //     return null;
  //   }
  // }
}