# API — Histórico de Trajetórias Softruck

Documentação para consumo dos endpoints de histórico de trajetórias no frontend React Native.

---

## Autenticação

Todos os endpoints requerem **JWT Bearer Token** no header:

```
Authorization: Bearer <token>
```

---

## Parâmetros comuns (Query Params)

Ambos os endpoints compartilham os mesmos parâmetros de query:

| Parâmetro    | Tipo     | Obrigatório | Descrição                               | Exemplo        |
|-------------|----------|-------------|------------------------------------------|----------------|
| `chassi`     | `string` | ✅ Sim       | Chassi do veículo cadastrado             | `9BWZZZ377VT004251` |
| `dataInicial`| `string` | ✅ Sim       | Data inicial no formato `YYYY-MM-DD`    | `2026-05-01`   |
| `dataFinal`  | `string` | ✅ Sim       | Data final no formato `YYYY-MM-DD`      | `2026-05-15`   |

**Regras de validação:**
- `dataFinal` deve ser **maior ou igual** a `dataInicial`
- O período máximo é de **31 dias**

---

## Endpoint 1 — Gerar PDF de Trajetos

Gera um relatório PDF com o histórico de trajetórias do veículo no período informado.

```
GET /rastreamento/historico/softruck/pdf
```

### Exemplo de requisição

```
GET /rastreamento/historico/softruck/pdf?chassi=9BWZZZ377VT004251&dataInicial=2026-05-01&dataFinal=2026-05-15
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Resposta de sucesso

- **Status:** `200 OK`
- **Content-Type:** `application/pdf`
- **Content-Disposition:** `inline; filename="trajetorias-9BWZZZ377VT004251-2026-05-01-2026-05-15.pdf"`
- **Body:** Buffer binário do arquivo PDF

### Como exibir no React Native

```typescript
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';

async function abrirPdfTrajetorias(chassi: string, dataInicial: string, dataFinal: string) {
  const token = await obterToken(); // sua lógica de token

  const url =
    `https://sua-api.com/rastreamento/historico/softruck/pdf` +
    `?chassi=${chassi}&dataInicial=${dataInicial}&dataFinal=${dataFinal}`;

  // Faz o download do PDF
  const fileUri = FileSystem.documentDirectory + `trajetorias-${chassi}.pdf`;
  const downloadResult = await FileSystem.downloadAsync(url, fileUri, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (downloadResult.status !== 200) {
    throw new Error('Falha ao baixar o PDF');
  }

  // Compartilha/abre o arquivo
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(downloadResult.uri, { mimeType: 'application/pdf' });
  }
}
```

---

## Endpoint 2 — Obter Rotas em GeoJSON

Retorna os dados estruturados de trajetórias no formato GeoJSON para uso em mapas, junto com um sumário do período.

```
GET /rastreamento/historico/softruck/rotas
```

### Exemplo de requisição

```
GET /rastreamento/historico/softruck/rotas?chassi=9BWZZZ377VT004251&dataInicial=2026-05-01&dataFinal=2026-05-15
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Resposta de sucesso

- **Status:** `200 OK`
- **Content-Type:** `application/json`

```json
{
  "vehicle": {
    "chassi": "9BWZZZ377VT004251",
    "plate": "ABC-1234",
    "brandName": "Volkswagen",
    "modelName": "Delivery"
  },
  "period": {
    "dataInicial": "2026-05-01",
    "dataFinal": "2026-05-15",
    "totalDias": 15
  },
  "summary": {
    "totalSegmentos": 42,
    "distanciaTotalMetros": 387450,
    "duracaoTotalSegundos": 54320,
    "velocidadeMaximaGeral": 112.5,
    "velocidadeMediaGeral": 58.3,
    "diasComDados": 13,
    "totalFeaturesDetalhadas": 8710,
    "totalAlarmes": 14
  },
  "geojson": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": {
          "type": "DETAILED",
          "point": {
            "did": "device-id-softruck",
            "acc": 20260501,
            "lng": -51.2089,
            "lat": -30.0277,
            "ign": true,
            "tag": "NORMAL",
            "val": "",
            "msg": "",
            "spd": 65.2,
            "dir": 180,
            "act": 1746057600
          }
        },
        "geometry": {
          "type": "Point",
          "coordinates": [-51.2089, -30.0277]
        }
      },
      {
        "type": "Feature",
        "properties": {
          "type": "ALARM",
          "tag": "SPEED",
          "val": "120",
          "msg": "Excesso de velocidade detectado",
          "point": {
            "did": "device-id-softruck",
            "acc": 20260501,
            "lng": -51.2015,
            "lat": -30.0340,
            "ign": true,
            "tag": "SPEED",
            "val": "120",
            "msg": "Excesso de velocidade detectado",
            "spd": 120.0,
            "dir": 175,
            "act": 1746061200
          }
        },
        "geometry": {
          "type": "Point",
          "coordinates": [-51.2015, -30.0340]
        }
      }
    ]
  },
  "grouped": {
    "routeFeatures": [
      {
        "type": "Feature",
        "properties": {
          "type": "DETAILED",
          "point": {
            "did": "device-id-softruck",
            "acc": 20260501,
            "lng": -51.2089,
            "lat": -30.0277,
            "ign": true,
            "tag": "NORMAL",
            "val": "",
            "msg": "",
            "spd": 65.2,
            "dir": 180,
            "act": 1746057600
          }
        },
        "geometry": {
          "type": "Point",
          "coordinates": [-51.2089, -30.0277]
        }
      }
    ],
    "alarmFeatures": [
      {
        "type": "Feature",
        "properties": {
          "type": "ALARM",
          "tag": "SPEED",
          "val": "120",
          "msg": "Excesso de velocidade detectado",
          "point": {
            "did": "device-id-softruck",
            "acc": 20260501,
            "lng": -51.2015,
            "lat": -30.0340,
            "ign": true,
            "tag": "SPEED",
            "val": "120",
            "msg": "Excesso de velocidade detectado",
            "spd": 120.0,
            "dir": 175,
            "act": 1746061200
          }
        },
        "geometry": {
          "type": "Point",
          "coordinates": [-51.2015, -30.0340]
        }
      }
    ]
  }
}
```

---

## Estrutura detalhada da resposta `/rotas`

### `vehicle` — Informações do veículo

| Campo       | Tipo     | Descrição                        |
|------------|----------|----------------------------------|
| `chassi`    | `string` | Chassi consultado                |
| `plate`     | `string` | Placa do veículo                 |
| `brandName` | `string` | Marca (ex.: `"Volkswagen"`)      |
| `modelName` | `string` | Modelo (ex.: `"Delivery"`)       |

---

### `period` — Período consultado

| Campo        | Tipo     | Descrição                                    |
|-------------|----------|----------------------------------------------|
| `dataInicial`| `string` | Data inicial (`YYYY-MM-DD`)                  |
| `dataFinal`  | `string` | Data final (`YYYY-MM-DD`)                    |
| `totalDias`  | `number` | Total de dias no intervalo (inclusivo)       |

---

### `summary` — Sumário consolidado do período

| Campo                    | Tipo     | Descrição                                          |
|-------------------------|----------|----------------------------------------------------|
| `totalSegmentos`         | `number` | Número total de viagens (trechos com motor ligado) |
| `distanciaTotalMetros`   | `number` | Distância total percorrida em **metros**           |
| `duracaoTotalSegundos`   | `number` | Tempo total em movimento em **segundos**           |
| `velocidadeMaximaGeral`  | `number` | Velocidade máxima registrada no período em **km/h**|
| `velocidadeMediaGeral`   | `number` | Velocidade média ponderada por distância em **km/h**|
| `diasComDados`           | `number` | Número de dias com pelo menos uma trajetória       |
| `totalFeaturesDetalhadas`| `number` | Total de pontos GPS `DETAILED` retornados          |
| `totalAlarmes`           | `number` | Total de features do tipo `ALARM` retornadas       |

**Conversões úteis no frontend:**

```typescript
// Metros → Quilômetros
const km = (summary.distanciaTotalMetros / 1000).toFixed(1); // "387.5"

// Segundos → horas e minutos
const horas = Math.floor(summary.duracaoTotalSegundos / 3600);
const minutos = Math.floor((summary.duracaoTotalSegundos % 3600) / 60);
const duracao = `${horas}h ${minutos}min`; // "15h 5min"
```

---

### `geojson` — FeatureCollection completa

Contém **todos** os pontos GPS (DETAILED + ALARM) no formato GeoJSON padrão. Compatível com bibliotecas como `react-native-maps`, `mapbox-gl`, `leaflet`, etc.

> **Atenção:** As coordenadas seguem o padrão GeoJSON — `[longitude, latitude]` (nessa ordem, invertida em relação à maioria das bibliotecas de mapa).

---

### `grouped` — Features separadas por tipo

| Campo           | Tipo              | Descrição                                                |
|----------------|-------------------|----------------------------------------------------------|
| `routeFeatures` | `Feature[]`       | Pontos de rota normais (`type: "DETAILED"`)              |
| `alarmFeatures` | `Feature[]`       | Eventos e alarmes registrados (`type: "ALARM"`)          |

---

### Estrutura de uma Feature GeoJSON

```typescript
interface Feature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [longitude: number, latitude: number]; // atenção: [lng, lat]
  };
  properties: {
    type: 'DETAILED' | 'ALARM';

    // Somente presentes em ALARM:
    tag?: string; // ex.: "SPEED", "GEOFENCE", "PANIC"
    val?: string; // valor numérico do alarme (string)
    msg?: string; // mensagem descritiva

    // Dados do ponto GPS
    point: {
      did: string;       // ID do dispositivo Softruck
      acc: number;       // Data no formato YYYYMMDD
      lng: number;       // Longitude
      lat: number;       // Latitude
      ign: boolean;      // Ignição ligada?
      tag: string;       // Tag do evento
      val: string;       // Valor do evento
      msg: string;       // Mensagem do evento
      spd?: number;      // Velocidade em km/h
      dir?: number;      // Direção em graus (0–360)
      act?: number;      // Timestamp Unix do GPS
      dis?: number;      // Distância acumulada em metros
    };
  };
}
```

---

## Exemplo completo de consumo no React Native

```typescript
// types/rastreamento.ts
export interface VehicleInfo {
  chassi: string;
  plate: string;
  brandName: string;
  modelName: string;
}

export interface PeriodInfo {
  dataInicial: string;
  dataFinal: string;
  totalDias: number;
}

export interface RotasSummary {
  totalSegmentos: number;
  distanciaTotalMetros: number;
  duracaoTotalSegundos: number;
  velocidadeMaximaGeral: number;
  velocidadeMediaGeral: number;
  diasComDados: number;
  totalFeaturesDetalhadas: number;
  totalAlarmes: number;
}

export interface GeoFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    type: 'DETAILED' | 'ALARM';
    tag?: string;
    val?: string;
    msg?: string;
    point: {
      did: string;
      acc: number;
      lng: number;
      lat: number;
      ign: boolean;
      tag: string;
      val: string;
      msg: string;
      spd?: number;
      dir?: number;
      act?: number;
      dis?: number;
    };
  };
}

export interface HistoricoRotasResponse {
  vehicle: VehicleInfo;
  period: PeriodInfo;
  summary: RotasSummary;
  geojson: { type: 'FeatureCollection'; features: GeoFeature[] };
  grouped: {
    routeFeatures: GeoFeature[];
    alarmFeatures: GeoFeature[];
  };
}
```

```typescript
// services/rastreamento.service.ts
const BASE_URL = 'https://sua-api.com';

export async function obterRotasHistorico(
  token: string,
  chassi: string,
  dataInicial: string, // 'YYYY-MM-DD'
  dataFinal: string,   // 'YYYY-MM-DD'
): Promise<HistoricoRotasResponse> {
  const params = new URLSearchParams({ chassi, dataInicial, dataFinal });
  const response = await fetch(
    `${BASE_URL}/rastreamento/historico/softruck/rotas?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    const erro = await response.json();
    throw new Error(erro.message ?? 'Erro ao buscar histórico de rotas');
  }

  return response.json();
}
```

```typescript
// Exemplo de uso em um componente
const { data, isLoading, error } = useQuery({
  queryKey: ['historico-rotas', chassi, dataInicial, dataFinal],
  queryFn: () => obterRotasHistorico(token, chassi, dataInicial, dataFinal),
  enabled: !!chassi && !!dataInicial && !!dataFinal,
});

// Extraindo coordenadas para react-native-maps
const polylineCoords = data?.grouped.routeFeatures.map((f) => ({
  latitude: f.geometry.coordinates[1],  // índice 1 = lat
  longitude: f.geometry.coordinates[0], // índice 0 = lng
})) ?? [];

// Marcadores de alarme
const alarmMarkers = data?.grouped.alarmFeatures.map((f) => ({
  coordinate: {
    latitude: f.geometry.coordinates[1],
    longitude: f.geometry.coordinates[0],
  },
  title: f.properties.tag ?? 'Alarme',
  description: f.properties.msg ?? '',
})) ?? [];
```

---

## Respostas de erro

Todos os endpoints seguem o padrão NestJS de erros:

### 400 Bad Request — Parâmetros inválidos

```json
{
  "statusCode": 400,
  "message": [
    "dataFinal deve ser maior ou igual a dataInicial",
    "O período máximo permitido é de 31 dias"
  ],
  "error": "Bad Request"
}
```

### 401 Unauthorized — Token ausente ou inválido

```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

### 404 Not Found — Veículo não encontrado no Softruck

```json
{
  "statusCode": 404,
  "message": "Veículo com chassi 9BWZZZ377VT004251 não encontrado na base Softruck",
  "error": "Not Found"
}
```

### 500 Internal Server Error — Falha na comunicação com Softruck

```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

---

## Notas de performance

- **Períodos longos** (próximos a 31 dias) podem demorar mais para responder, pois a API realiza consultas paralelas (máx. 3 simultâneas) para cada dia do período.
- O endpoint `/rotas` faz **duas rodadas de consultas**: primeira para by-keys (sumário diário), segunda para geom (pontos GPS). Para um período de 31 dias, isso representa até 62 chamadas à API Softruck — espere entre **5–15 segundos** dependendo do volume de dados.
- O endpoint `/pdf` realiza apenas a primeira rodada (by-keys), sendo mais rápido.
- Recomenda-se exibir um **indicador de carregamento** visível ao usuário durante as requisições.

---

*Gerado em 20/05/2026 | API versão atual*
