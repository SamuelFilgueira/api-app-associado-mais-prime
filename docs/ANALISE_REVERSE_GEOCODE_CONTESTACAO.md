# Análise do Fluxo de Obtenção de Endereço — Relatório de Contestação de Multa

> Documento gerado em 07/07/2026. Análise do sistema **como está hoje**, sem proposta de alterações.

---

## 1. Ponto de Entrada

O fluxo começa em **dois endpoints** no controller M7:

| Rota | Método no Controller | Observação |
|------|---------------------|------------|
| `GET /rastreamento/historico/m7/pdf-contestacao` | `gerarPdfContestacao` | Endpoint original |
| `GET /rastreamento/historico/m7/pdf-contestacao-v2` | `gerarPdfContestacaoV2` | Novo endpoint — mesmo geocode, layout diferente |

**Arquivo:** `src/rastreamento/m7/controllers/historico-m7.controller.ts`

**Query params obrigatórios (ambos):**
- `cnpj`
- `chassi`
- `dataInicial` (YYYY-MM-DD)
- `dataFinal` (YYYY-MM-DD) — máximo 5 dias de intervalo

---

## 2. Cadeia de Chamadas até o Endereço

```
Controller.gerarPdfContestacao / gerarPdfContestacaoV2
  └─ Service.gerarPdfContestacao / gerarPdfContestacaoV2  [historico-m7.service.ts]
       ├─ validarPeriodoMaximoContestacao()               [validação: máx. 5 dias]
       ├─ consultarVeiculo()                              [POST M7 /api/veiculos/consulta]
       ├─ buscarHistoricoGps()                            [GET M7 /api/historico/{di}/{df}/{codigo}]
       └─ montarPontosContestacao()
            ├─ normalizarCoordenada()                     [por ponto]
            ├─ deduplicação de coordenadas únicas
            └─ reverseGeocodeEmLote()
                 └─ reverseGeocodeCoordenada()            [por coordenada única]
                      ├─ [cache em memória]               → retorna imediatamente se hit
                      ├─ buscarReverseGeocodeNominatimMysql()  ← ETAPA PRINCIPAL
                      ├─ buscarReverseGeocodeCacheMysql() ← fallback 1 (se env habilitado)
                      └─ HTTP GET nominatim.openstreetmap.org  ← fallback 2
```

---

## 3. Arquivos Relevantes e Responsabilidades

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/rastreamento/m7/controllers/historico-m7.controller.ts` | Ponto de entrada HTTP, parsing de query params, envio do PDF como resposta |
| `src/rastreamento/m7/dto/historico-m7-query.dto.ts` | Validação dos query params (`HistoricoM7ContestacaoQueryDto`), incluindo limite de 5 dias |
| `src/rastreamento/m7/services/historico-m7.service.ts` | Toda a lógica de negócio: autenticação M7, busca de pontos GPS, geocoding, montagem dos dados |
| `src/rastreamento/m7/pdf/historico-pdf-m7.service.ts` | Renderização HTML → PDF via Puppeteer |
| `src/rastreamento/m7/interfaces/m7-historico.interface.ts` | Tipagem dos dados brutos da API M7 (`M7PontoHistoricoRaw`) |
| `src/rastreamento/m7/dto/historico-m7-response.dto.ts` | DTOs de saída: `HistoricoM7ContestacaoPontoDto`, `HistoricoM7ContestacaoPdfDataDto` |
| `prisma/schema.prisma` | Modelo `reverse_geocode_cache` (cache legado de geocode) |

---

## 4. Como é Feita a Busca do Endereço

### Função principal: `buscarReverseGeocodeNominatimMysql`

**Arquivo:** `src/rastreamento/m7/services/historico-m7.service.ts`

A função recebe `latitude` e `longitude` (strings com 6 casas decimais) e executa **3 queries SQL em paralelo** contra o banco MySQL `nominatim_rj`, tabela `placex`:

---

## 5. Tabelas Utilizadas

### Tabela principal: `nominatim_rj.placex`

Banco derivado do OpenStreetMap importado para MySQL. Contém ~402.038 registros geográficos do estado do RJ.

| Coluna relevante | Tipo | Uso |
|-----------------|------|-----|
| `latitude` | FLOAT | Filtro por bounding box e ordenação por distância |
| `longitude` | FLOAT | Filtro por bounding box e ordenação por distância |
| `class` | VARCHAR | Filtro por tipo: `highway`, `place`, `boundary` |
| `type` | VARCHAR | Subtipo: `residential`, `quarter`, `neighbourhood`, `suburb`, `administrative` |
| `admin_level` | INT | Nível administrativo — usado para filtrar município (valor `8`) |
| `name` | VARCHAR | Nome do elemento em inglês / padrão |
| `name_pt` | VARCHAR | Nome em português — preferido quando disponível |
| `postcode` | VARCHAR | CEP — extraído da query de rua |

### Tabela secundária (fallback): `reverse_geocode_cache`

Tabela no banco principal (schema Prisma). Só consultada se `M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK=true` (padrão: **desabilitado**).

| Coluna relevante | Tipo |
|-----------------|------|
| `provider` | VARCHAR(40) |
| `lat_key`, `lng_key` | INT (lat/lon × 100.000) |
| `latitude`, `longitude` | DECIMAL(10,7) |
| `address` | VARCHAR(300) — endereço formatado completo |
| `confidence` | VARCHAR(40) |

---

## 6. Índices Utilizados (nominatim_rj.placex)

As queries filtram por `latitude BETWEEN` e `longitude BETWEEN`. O índice eficaz depende da existência de índice composto ou separado em `(latitude, longitude)` na tabela `placex`.

Índices conhecidos na `reverse_geocode_cache` (schema Prisma):
```
@@unique([provider, lat_key, lng_key], map: "uniq_provider_lat_lng")
@@index([lat_key, lng_key], map: "idx_lat_lng")
```

---

## 7. SQL Executado (equivalente gerado dinamicamente)

As 3 queries são executadas **em paralelo** via `Promise.all`. Abaixo o SQL equivalente para `lat = -22.888884`, `lon = -43.474387`:

### Query 1 — Rua (raio ~500 m = 0.005°)

```sql
SELECT name, name_pt, type, postcode, admin_level
FROM `nominatim_rj`.`placex`
WHERE latitude  BETWEEN -22.893884 AND -22.883884
  AND longitude BETWEEN -43.479387 AND -43.469387
  AND class = 'highway'
ORDER BY ((latitude-(-22.888884))*(latitude-(-22.888884)) + (longitude-(-43.474387))*(longitude-(-43.474387))) ASC
LIMIT 3;
```

### Query 2 — Bairro/Quarter (raio ~3 km = 0.03°)

```sql
SELECT name, name_pt, type, postcode, admin_level
FROM `nominatim_rj`.`placex`
WHERE latitude  BETWEEN -22.918884 AND -22.858884
  AND longitude BETWEEN -43.504387 AND -43.444387
  AND class = 'place'
  AND type IN ('quarter', 'neighbourhood', 'suburb')
ORDER BY ((latitude-(-22.888884))*(latitude-(-22.888884)) + (longitude-(-43.474387))*(longitude-(-43.474387))) ASC
LIMIT 5;
```

### Query 3 — Município (raio ~50 km = 0.5°)

```sql
SELECT name, name_pt, type, postcode, admin_level
FROM `nominatim_rj`.`placex`
WHERE latitude  BETWEEN -23.388884 AND -22.388884
  AND longitude BETWEEN -43.974387 AND -42.974387
  AND class = 'boundary'
  AND type = 'administrative'
  AND admin_level = 8
ORDER BY ((latitude-(-22.888884))*(latitude-(-22.888884)) + (longitude-(-43.474387))*(longitude-(-43.474387))) ASC
LIMIT 1;
```

> **Nota sobre fallback sem prefixo de banco:** Se a query com `nominatim_rj.placex` falhar, a mesma query é re-executada sem o prefixo de banco (apenas `placex`). Isso permite compatibilidade com ambientes onde o banco padrão da conexão já é `nominatim_rj`.

---

## 8. Como é Determinada a Rua Correta

**Algoritmo de seleção:** distância mínima pelo centróide do registro na tabela `placex`.

A expressão de ordenação é:
```
((latitude - LAT)² + (longitude - LON)²)
```

Isso é uma **distância euclidiana ao quadrado** (sem raiz quadrada, pois só serve para ordenação relativa). O registro com menor valor é o mais próximo.

**Limitação conhecida:** `placex` armazena o **centróide** de cada via, não a geometria linear completa. Isso significa que para ruas longas, o centróide pode estar longe do ponto de interesse, fazendo outra rua mais curta mas com centróide mais próximo aparecer primeiro. O Nominatim oficial usa `ST_ClosestPoint` sobre a geometria completa (PostGIS), o que é mais preciso.

---

## 9. Algoritmo de Ranking

Para cada componente do endereço há uma regra de seleção distinta:

### Rua
- Retorna o **primeiro registro** (índice `[0]`) da Query 1 (o mais próximo).
- Não há ranking adicional — vence a menor distância euclidiana ao centróide.

### Bairro
Existe **priorização por tipo** (mais específico → menos específico):
```
quarter > neighbourhood > suburb
```
Código:
```typescript
const bairroRow =
  bairroRows.find((r) => r.type === 'quarter') ??        // 1ª escolha
  bairroRows.find((r) => r.type === 'neighbourhood') ??  // 2ª escolha
  bairroRows[0] ?? null;                                 // qualquer resultado mais próximo
```

### Município
- Retorna o **único** resultado mais próximo com `admin_level = 8`.
- Se `cidadeOverride` estiver disponível (campo `cidade` do ponto GPS da API M7), ele é usado diretamente, **ignorando** o resultado do banco.

### Nome preferido
Para cada registro selecionado:
```typescript
const pickName = (row) => row.name_pt ?? row.name;
```
`name_pt` (português) tem prioridade sobre `name` (inglês/padrão).

---

## 10. Etapas de Cache

### Cache 1: In-memory (`reverseGeocodeCache`)

**Tipo:** `Map<string, string>` em memória no processo Node.js.
**Chave:** `"lat,lon"` (ex: `"-22.888884,-43.474387"`).
**Comportamento:** Verificado primeiro. Se houver hit, retorna imediatamente sem consultar banco.
**Limitação:** Limpo ao reiniciar o servidor. Não é compartilhado entre instâncias.

### Cache 2: In-flight deduplication (`reverseGeocodeInFlight`)

**Tipo:** `Map<string, Promise<string>>`.
**Objetivo:** Evitar consultas duplicadas simultâneas para a mesma coordenada. Se uma Promise já estiver em andamento para a chave, as demais chamadas aguardam o mesmo resultado.

### Cache 3: `reverse_geocode_cache` (MySQL) — DESABILITADO por padrão

**Variável de controle:** `M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK` (padrão: `false`).
**Quando ativo:** Consultado como fallback após falha no nominatim_rj.
**Escrita:** Controlada por `M7_REV_GEOCODE_SAVE_LEGACY_CACHE` (padrão: `false`).

### Cache 4: `montarPontosContestacao` — deduplicação de coordenadas

Antes do geocoding, `montarPontosContestacao` agrupa os pontos GPS em um `Map<coordenada, item>`, garantindo que coordenadas repetidas sejam geocodificadas **apenas uma vez**:
```typescript
const mapaUnicos = new Map<string, ReverseGeocodeItem>();
for (const item of normalizados) {
  if (!mapaUnicos.has(item.key)) {
    mapaUnicos.set(item.key, { ... });
  }
}
```

---

## 11. Etapa de Normalização do Endereço

### `normalizarCoordenada`
Converte qualquer formato de lat/lon (string ou número, com vírgula ou ponto) para string com 6 casas decimais:
```
"-22.888884" | -22.888884 | "-22,888884" → "-22.888884"
```

### `pickName` (dentro de `buscarReverseGeocodeNominatimMysql`)
Seleciona o nome do registro: prefere `name_pt` sobre `name`. Se ambos forem nulos ou vazios, retorna `null`.

### Montagem final do endereço
```typescript
const partes: string[] = [];
if (rua)    partes.push(rua);
if (bairro) partes.push(bairro);
partes.push(cidade);
partes.push('RJ');
if (cep)    partes.push(cep);
// Separador: ", "
```

**Exemplo de saída:** `Rua Boiobi, Rio da Prata, Rio de Janeiro, RJ, 21825-060`

---

## 12. Etapas de Reverse Geocoding

O sistema possui **3 camadas de reverse geocoding** com prioridade decrescente:

| Prioridade | Fonte | Condição |
|-----------|-------|---------|
| **1ª** | `nominatim_rj.placex` (MySQL local) | Sempre tentado (se `M7_NOMINATIM_ENABLED=true`, padrão) |
| **2ª** | `reverse_geocode_cache` (MySQL legado) | Só se `M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK=true` (padrão: desabilitado) |
| **3ª** | `nominatim.openstreetmap.org` (API externa) | Fallback final quando camadas 1 e 2 falharem |
| **Último recurso** | `"lat, lon"` | Se tudo falhar, retorna as coordenadas brutas |

---

## 13. O Sistema Consulta `housenumber`?

**Não diretamente na seleção do endereço.** 

As 3 queries consultam apenas:
- `class = 'highway'` (ruas) — centróides de vias
- `class = 'place'` (bairros) — centróides de lugares
- `class = 'boundary'` (municípios) — centróides administrativos

A coluna `housenumber` da tabela `placex` **não é filtrada nem retornada** nas queries atuais. Registros com `housenumber` (ex: entradas individuais de imóveis) **nunca são selecionados**, pois esses registros tipicamente têm `class = 'place'` com `type = 'house'` ou são nós de endereçamento que não se encaixam nos filtros `class = 'highway'`.

---

## 14. A Tabela `placex` é Consultada Diretamente?

**Sim.** Via `prisma.$queryRawUnsafe<PlacexRow[]>(sql, ...)` no método `buscarReverseGeocodeNominatimMysql`. O Prisma é usado apenas como executor SQL, não como ORM mapeado para esse banco.

```typescript
const rows = await this.prisma.$queryRawUnsafe<PlacexRow[]>(
  sql,
  lat - rLat, lat + rLat,
  lon - rLon, lon + rLon,
);
```

Os parâmetros são passados como bind parameters (`?`), evitando SQL injection.

---

## 15. Tabela `nominatim_rj.placex` — Origem e Colunas

### Como foi construída
Derivada do OpenStreetMap (OSM), importada via Nominatim 4.5 a partir do arquivo `south-east-latest.osm.pbf` filtrado espacialmente para o estado do RJ. Contém ~402.038 registros.

### Colunas utilizadas pelo sistema

| Coluna | Tipo declarado | Uso no sistema |
|--------|---------------|----------------|
| `latitude` | FLOAT/DECIMAL | Filtro bounding box e cálculo de distância |
| `longitude` | FLOAT/DECIMAL | Filtro bounding box e cálculo de distância |
| `class` | VARCHAR(100) | Filtro: `highway`, `place`, `boundary` |
| `type` | VARCHAR(100) | Filtro e ranking: `residential`, `quarter`, `neighbourhood`, `suburb`, `administrative` |
| `admin_level` | INT | Filtro para município: valor `8` |
| `name` | VARCHAR(500) | Nome do elemento (fallback para `name_pt`) |
| `name_pt` | VARCHAR(500) | Nome em português (preferido) |
| `postcode` | VARCHAR(20) | CEP — extraído da query de rua |
| `housenumber` | VARCHAR(100) | **Não utilizado** no fluxo atual |
| `osm_id`, `osm_type`, etc. | Vários | **Não utilizados** |

---

## 16. Informações do Endereço Retornadas ao Relatório

O campo `endereco` do DTO `HistoricoM7ContestacaoPontoDto` contém o endereço montado como string única no formato:

```
{rua}, {bairro}, {cidade}, {estado}, {CEP}
```

| Componente | Origem | Exemplo |
|-----------|--------|---------|
| Rua | `name_pt ?? name` do registro `class='highway'` mais próximo | `Rua Boiobi` |
| Bairro | `name_pt ?? name` do registro `class='place'` (quarter > neighbourhood > suburb) | `Rio da Prata` |
| Cidade | Campo `cidade` do ponto GPS da API M7 (override) **ou** `name` do `admin_level=8` | `Rio de Janeiro` |
| Estado | Literal fixo `'RJ'` | `RJ` |
| CEP | `postcode` do registro de rua | `21825-060` |

**Campos que NÃO estão presentes no endereço retornado:**
- Número do imóvel (`housenumber`)
- Complemento
- Referência de logradouro

---

## 17. Onde Adicionar Busca por Número de Imóvel

O ponto ideal para inserir uma segunda etapa de busca por `housenumber` seria **dentro de `buscarReverseGeocodeNominatimMysql`**, logo após a Query 1 (rua) e antes da montagem do endereço final.

A query adicional seria uma Query 4 com raio menor (~50 m = 0.0005°), filtrando por `housenumber IS NOT NULL`:

```sql
SELECT name, name_pt, housenumber, postcode
FROM `nominatim_rj`.`placex`
WHERE latitude  BETWEEN LAT-0.0005 AND LAT+0.0005
  AND longitude BETWEEN LON-0.0005 AND LON+0.0005
  AND housenumber IS NOT NULL
ORDER BY ((latitude-LAT)² + (longitude-LON)²) ASC
LIMIT 1;
```

O número encontrado seria então inserido após o nome da rua:
```
Rua Boiobi, 59 → Rua Boiobi, 59, Rio da Prata, Rio de Janeiro, RJ, 21825-060
```

---

## Diagrama do Fluxo Completo

```
HTTP GET /pdf-contestacao-v2
  ?cnpj=...&chassi=...&dataInicial=...&dataFinal=...
         │
         ▼
[Controller] gerarPdfContestacaoV2
         │
         ▼
[Service] validarPeriodoMaximoContestacao()
  → Rejeita se período > 5 dias (BadRequestException)
         │
         ▼
[Service] consultarVeiculo()
  → POST M7_API_BASE_URL/api/veiculos/consulta
  → Retorna: codigo, placa, chassi
         │
         ▼
[Service] buscarHistoricoGps()
  → GET M7_API_BASE_URL/api/historico/{dataInicial}/{dataFinal+1dia}/{codigo}
  → Filtra pontos fora do período selecionado
  → Retorna: lista de M7PontoHistoricoRaw[]
         │
         ▼
[Service] montarPontosContestacao()
  ├─ normalizarCoordenada()       → lat/lon para 6 casas decimais
  ├─ deduplicar coordenadas       → Map<"lat,lon", item>
  │
  └─ reverseGeocodeEmLote()
       → Processa em lotes de 6 coordenadas únicas em paralelo
              │
              ▼
       reverseGeocodeCoordenada()
         │
         ├─ [CACHE 1] reverseGeocodeCache (Map em memória)
         │      └─ HIT → retorna imediatamente
         │      └─ MISS → continua
         │
         ├─ [CACHE 2] reverseGeocodeInFlight (Promise deduplication)
         │      └─ Em andamento → aguarda mesma Promise
         │      └─ Novo → cria Promise e registra
         │
         └─ buscarReverseGeocodeNominatimMysql()
              │
              ├─ [QUERY 1] nominatim_rj.placex
              │   WHERE class='highway'
              │   raio 0.005° (~500m)
              │   ORDER BY distância euclidiana² ASC LIMIT 3
              │   → rua = ruasRows[0].name_pt ?? name
              │   → cep = ruasRows[*].postcode (primeiro não nulo)
              │
              ├─ [QUERY 2] nominatim_rj.placex
              │   WHERE class='place' AND type IN (quarter, neighbourhood, suburb)
              │   raio 0.03° (~3km)
              │   ORDER BY distância euclidiana² ASC LIMIT 5
              │   → bairro = quarter > neighbourhood > suburb (ranking por tipo)
              │   → dentro do tipo: menor distância vence
              │
              ├─ [QUERY 3] nominatim_rj.placex
              │   WHERE class='boundary' AND type='administrative' AND admin_level=8
              │   raio 0.5° (~50km)
              │   ORDER BY distância euclidiana² ASC LIMIT 1
              │   → cidade = cidadeOverride (campo cidade da API M7) ?? resultado ?? 'Rio de Janeiro'
              │
              ├─ Monta string: "rua, bairro, cidade, RJ, cep"
              │   Ex: "Rua Boiobi, Rio da Prata, Rio de Janeiro, RJ, 21825-060"
              │
              │  [Se nominatim_rj retornar null ou falhar]
              ├─ [FALLBACK 1] buscarReverseGeocodeCacheMysql()   (se M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK=true)
              │   → reverse_geocode_cache WHERE lat_key/lng_key ± raio
              │   → ranking: menor distância euclidiana²
              │
              └─ [FALLBACK 2] HTTP GET nominatim.openstreetmap.org/reverse
                   → display_name ou concatenação de campos address
                   → salva em reverse_geocode_cache (se M7_REV_GEOCODE_SAVE_LEGACY_CACHE=true)
                   → Se falhar: retorna "lat, lon" como string bruta
         │
         ▼
[Service] Monta HistoricoM7ContestacaoPdfDataDto
  { veiculo, periodo, pontos: [{placa, dataGps, velocidade, endereco, lat, lon}] }
         │
         ▼
[PDF Service] gerarPdfContestacaoV2()
  → Puppeteer renderiza HTML → PDF
  → Tabela: Data | Hora | Velocidade | Endereço | Latitude | Longitude
         │
         ▼
HTTP Response: application/pdf
  Content-Disposition: inline; filename="historico-m7-contestacao-v2-{chassi}-{di}-{df}.pdf"
```

---

## Variáveis de Ambiente Relevantes

| Variável | Padrão | Efeito |
|---------|--------|--------|
| `M7_NOMINATIM_ENABLED` | `true` | Habilita/desabilita consulta ao banco `nominatim_rj` |
| `M7_NOMINATIM_DB` | `nominatim_rj` | Nome do banco MySQL com a tabela `placex` |
| `M7_NOMINATIM_TABLE` | `placex` | Nome da tabela de geocoding |
| `M7_NOMINATIM_RADIUS_DEGREES` | `0.01` | Raio padrão (não usado diretamente; cada query usa seus próprios raios fixos) |
| `M7_REV_GEOCODE_LEGACY_CACHE_FALLBACK` | `false` | Ativa consulta à `reverse_geocode_cache` como fallback |
| `M7_REV_GEOCODE_SAVE_LEGACY_CACHE` | `false` | Persiste resultados externos na `reverse_geocode_cache` |
| `M7_REVERSE_GEOCODE_URL` | `https://nominatim.openstreetmap.org/reverse` | URL do fallback externo |
| `M7_REV_GEOCODE_CACHE_PROVIDERS` | `osm_rj,external_reverse_geocode` | Providers aceitos no cache legado |
| `M7_API_BASE_URL` | — | Base URL da API M7 |

---

*Fim da análise. Nenhuma alteração de código foi realizada.*
