# API — Histórico de Trajetórias M7

Documentação para consumo dos endpoints de histórico de trajetórias M7 no frontend React Native (Expo SDK 55).

---

## Autenticação

Todos os endpoints requerem **JWT Bearer Token** no header:

```
Authorization: Bearer <token>
```

---

## Parâmetros comuns (Query Params)

Os três endpoints compartilham os mesmos parâmetros de query:

| Parâmetro     | Tipo     | Obrigatório | Descrição                                     | Exemplo                    |
|--------------|----------|-------------|-----------------------------------------------|----------------------------|
| `cnpj`        | `string` | ✅ Sim       | CNPJ da empresa dona do veículo               | `12.345.678/0001-99`       |
| `chassi`      | `string` | ✅ Sim       | Chassi do veículo cadastrado                  | `9BWZZZ377VT004251`        |
| `dataInicial` | `string` | ✅ Sim       | Data inicial no formato `YYYY-MM-DD`          | `2026-05-01`               |
| `dataFinal`   | `string` | ✅ Sim       | Data final no formato `YYYY-MM-DD`            | `2026-05-15`               |

**Regras de validação:**
- `dataFinal` deve ser **maior ou igual** a `dataInicial`
- O período máximo é de **31 dias**

---

## Endpoint 1 — Gerar PDF de Trajetos

Gera um relatório PDF com o histórico de trajetórias do veículo no período informado.

```
GET /rastreamento/historico/m7/pdf
```

### Exemplo de requisição

```
GET /rastreamento/historico/m7/pdf?cnpj=12.345.678/0001-99&chassi=9BWZZZ377VT004251&dataInicial=2026-05-01&dataFinal=2026-05-15
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Resposta de sucesso

- **Status:** `200 OK`
- **Content-Type:** `application/pdf`
- **Content-Disposition:** `inline; filename="historico-m7-9BWZZZ377VT004251-2026-05-01-2026-05-15.pdf"`
- **Body:** Buffer binário do arquivo PDF

O PDF contém uma tabela de trajetos com as colunas: **Tipo**, **Início**, **Fim**, **Movimento**, **Parado**, **Total**, **Distância**, **Vel. Máx.** e **Destino**.

### Como baixar e abrir no React Native (Expo SDK 55)

```typescript
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

async function baixarPdfM7(
  token: string,
  cnpj: string,
  chassi: string,
  dataInicial: string,
  dataFinal: string,
): Promise<void> {
  const params = new URLSearchParams({ cnpj, chassi, dataInicial, dataFinal });
  const url = `${BASE_URL}/rastreamento/historico/m7/pdf?${params.toString()}`;

  const safeChassi = chassi.replace(/[^A-Za-z0-9_-]/g, '');
  const fileUri =
    FileSystem.documentDirectory +
    `historico-m7-${safeChassi}-${dataInicial}-${dataFinal}.pdf`;

  const download = await FileSystem.downloadAsync(url, fileUri, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (download.status !== 200) {
    throw new Error('Falha ao baixar o relatório PDF');
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(download.uri, { mimeType: 'application/pdf' });
  }
}
```

---

## Endpoint 2 — Resumo de Viagens por Período

Retorna o histórico de viagens agrupado por dia, seguindo o modelo de transição de estados **PARADO → VIAGEM → PARADO** da plataforma M7.

Use este endpoint para exibir listas de viagens, telas de histórico diário e estatísticas do período.

```
GET /rastreamento/historico/m7/resumo
```

### Exemplo de requisição

```
GET /rastreamento/historico/m7/resumo?cnpj=12.345.678/0001-99&chassi=9BWZZZ377VT004251&dataInicial=2026-05-01&dataFinal=2026-05-15
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Resposta de sucesso

- **Status:** `200 OK`
- **Content-Type:** `application/json`

```json
{
  "veiculo": {
    "codigo": 168630,
    "placa": "ABC-1234",
    "chassi": "9BWZZZ377VT004251"
  },
  "periodo": {
    "dataInicial": "2026-05-01",
    "dataFinal": "2026-05-15"
  },
  "resumo": {
    "diasComDados": 2,
    "totalViagens": 5,
    "distanciaTotalKm": 42.3,
    "velocidadeMaxima": 98.5
  },
  "dias": [
    {
      "data": "2026-05-10",
      "distanciaTotalKm": 24.1,
      "viagens": [
        {
          "origem": "Rua Cobé, 123 - Porto Alegre",
          "saida": "2026-05-10 08:00:00",
          "destino": "Av. Ipiranga, 6681 - Porto Alegre",
          "chegada": "2026-05-10 08:22:00",
          "distanciaKm": 8.4,
          "tempoMovimento": "00:22:00",
          "velocidadeMaxima": 87.0
        },
        {
          "origem": "Av. Ipiranga, 6681 - Porto Alegre",
          "saida": "2026-05-10 11:39:09",
          "destino": "R. Bangu, 40 - Porto Alegre",
          "chegada": "2026-05-10 11:44:39",
          "distanciaKm": 1.4,
          "tempoMovimento": "00:05:30",
          "velocidadeMaxima": 67.0
        }
      ]
    },
    {
      "data": "2026-05-12",
      "distanciaTotalKm": 18.2,
      "viagens": [
        {
          "origem": "R. Bangu, 40 - Porto Alegre",
          "saida": "2026-05-12 07:45:00",
          "destino": "Rua Cobé, 123 - Porto Alegre",
          "chegada": "2026-05-12 08:10:00",
          "distanciaKm": 18.2,
          "tempoMovimento": "00:25:00",
          "velocidadeMaxima": 98.5
        }
      ]
    }
  ]
}
```

---

### Estrutura detalhada da resposta `/resumo`

#### `veiculo` — Informações do veículo

| Campo    | Tipo     | Descrição                              |
|---------|----------|----------------------------------------|
| `codigo` | `number` | Código interno do veículo na API M7    |
| `placa`  | `string` | Placa do veículo                       |
| `chassi` | `string` | Chassi consultado                      |

#### `periodo` — Período consultado

| Campo         | Tipo     | Descrição                   |
|--------------|----------|-----------------------------|
| `dataInicial` | `string` | Data inicial (`YYYY-MM-DD`) |
| `dataFinal`   | `string` | Data final (`YYYY-MM-DD`)   |

#### `resumo` — Totais do período

| Campo               | Tipo     | Descrição                                          |
|--------------------|----------|----------------------------------------------------|
| `diasComDados`      | `number` | Quantidade de dias com ao menos uma viagem válida  |
| `totalViagens`      | `number` | Total de viagens válidas no período                |
| `distanciaTotalKm`  | `number` | Distância total percorrida em **quilômetros**       |
| `velocidadeMaxima`  | `number` | Velocidade máxima registrada no período (km/h)     |

#### `dias` — Array de dias

| Campo              | Tipo             | Descrição                                      |
|-------------------|------------------|------------------------------------------------|
| `data`             | `string`         | Data no formato `YYYY-MM-DD`                   |
| `distanciaTotalKm` | `number`         | Distância total do dia em km                   |
| `viagens`          | `ViagemM7[]`     | Lista de viagens do dia em ordem cronológica   |

#### Cada item de `viagens`

| Campo             | Tipo     | Descrição                                                                     |
|------------------|----------|-------------------------------------------------------------------------------|
| `origem`          | `string` | Endereço de **saída** — local onde o veículo estava parado antes da viagem    |
| `saida`           | `string` | Data/hora de saída (`YYYY-MM-DD HH:mm:ss`)                                    |
| `destino`         | `string` | Endereço de **chegada** da viagem                                             |
| `chegada`         | `string` | Data/hora de chegada (`YYYY-MM-DD HH:mm:ss`)                                  |
| `distanciaKm`     | `number` | Distância percorrida nessa viagem em **quilômetros**                          |
| `tempoMovimento`  | `string` | Tempo em movimento no formato `HH:mm:ss`                                     |
| `velocidadeMaxima`| `number` | Velocidade máxima registrada durante a viagem (km/h)                         |

> **Importante:** Viagens com `distanciaKm = 0` ou `tempoMovimento = "00:00:00"` são automaticamente filtradas pelo backend (ruído de telemetria).

---

### Tipagem TypeScript (React Native / Expo)

```typescript
// types/rastreamento-m7.ts (adicionar às tipagens existentes)

export interface ViagemM7 {
  origem: string;
  saida: string;
  destino: string;
  chegada: string;
  distanciaKm: number;
  tempoMovimento: string;
  velocidadeMaxima: number;
}

export interface DiaM7 {
  data: string;
  distanciaTotalKm: number;
  viagens: ViagemM7[];
}

export interface ResumoM7 {
  diasComDados: number;
  totalViagens: number;
  distanciaTotalKm: number;
  velocidadeMaxima: number;
}

export interface HistoricoM7ResumoResponse {
  veiculo: VeiculoM7;
  periodo: PeriodoM7;
  resumo: ResumoM7;
  dias: DiaM7[];
}
```

---

### Serviço de API

```typescript
// services/rastreamento-m7.service.ts
import { HistoricoM7ResumoResponse } from '../types/rastreamento-m7';

export async function obterResumoM7(
  token: string,
  cnpj: string,
  chassi: string,
  dataInicial: string, // 'YYYY-MM-DD'
  dataFinal: string,   // 'YYYY-MM-DD'
): Promise<HistoricoM7ResumoResponse> {
  const params = new URLSearchParams({ cnpj, chassi, dataInicial, dataFinal });
  const response = await fetch(
    `${BASE_URL}/rastreamento/historico/m7/resumo?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    const erro = await response.json().catch(() => ({}));
    throw new Error(
      (erro as { message?: string }).message ?? 'Erro ao buscar resumo M7',
    );
  }

  return response.json() as Promise<HistoricoM7ResumoResponse>;
}
```

---

### Uso com React Query

```typescript
import { useQuery } from '@tanstack/react-query';
import { obterResumoM7 } from '../services/rastreamento-m7.service';

function useResumoM7(
  token: string,
  cnpj: string,
  chassi: string,
  dataInicial: string,
  dataFinal: string,
) {
  return useQuery({
    queryKey: ['historico-resumo-m7', cnpj, chassi, dataInicial, dataFinal],
    queryFn: () => obterResumoM7(token, cnpj, chassi, dataInicial, dataFinal),
    enabled: !!token && !!cnpj && !!chassi && !!dataInicial && !!dataFinal,
    staleTime: 5 * 60 * 1000, // 5 minutos
  });
}
```

---

### Exemplo de tela — Lista de viagens por dia

```typescript
import React from 'react';
import { View, Text, FlatList, SectionList, StyleSheet } from 'react-native';
import { useResumoM7 } from '../hooks/useResumoM7';
import { DiaM7, ViagemM7 } from '../types/rastreamento-m7';

function formatarHora(datetime: string): string {
  // '2026-05-10 11:39:09' → '11:39'
  return datetime.slice(11, 16);
}

function formatarData(data: string): string {
  // '2026-05-10' → '10/05/2026'
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano}`;
}

function CardViagem({ viagem }: { viagem: ViagemM7 }) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.hora}>{formatarHora(viagem.saida)}</Text>
        <Text style={styles.endereco} numberOfLines={1}>{viagem.origem}</Text>
      </View>
      <View style={styles.linha} />
      <View style={styles.row}>
        <Text style={styles.hora}>{formatarHora(viagem.chegada)}</Text>
        <Text style={styles.endereco} numberOfLines={1}>{viagem.destino}</Text>
      </View>
      <View style={styles.stats}>
        <Text style={styles.stat}>{viagem.distanciaKm.toFixed(1)} km</Text>
        <Text style={styles.stat}>{viagem.tempoMovimento}</Text>
        <Text style={styles.stat}>Máx. {viagem.velocidadeMaxima} km/h</Text>
      </View>
    </View>
  );
}

function TelaHistoricoM7({
  token,
  cnpj,
  chassi,
  dataInicial,
  dataFinal,
}: {
  token: string;
  cnpj: string;
  chassi: string;
  dataInicial: string;
  dataFinal: string;
}) {
  const { data, isLoading, isError } = useResumoM7(
    token, cnpj, chassi, dataInicial, dataFinal,
  );

  if (isLoading) return <Text>Carregando...</Text>;
  if (isError || !data) return <Text>Erro ao carregar histórico.</Text>;

  const sections = data.dias.map((dia: DiaM7) => ({
    title: `${formatarData(dia.data)} — ${dia.distanciaTotalKm.toFixed(1)} km`,
    data: dia.viagens,
  }));

  return (
    <View style={{ flex: 1 }}>
      {/* Cabeçalho do período */}
      <View style={styles.header}>
        <Text style={styles.headerText}>
          {data.resumo.totalViagens} viagens · {data.resumo.distanciaTotalKm.toFixed(1)} km
        </Text>
        <Text style={styles.headerSub}>
          {data.resumo.diasComDados} dias com dados
        </Text>
      </View>

      {/* Lista agrupada por dia */}
      <SectionList
        sections={sections}
        keyExtractor={(item, index) => `${item.saida}-${index}`}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => <CardViagem viagem={item} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { padding: 16, backgroundColor: '#f5f5f5' },
  headerText: { fontSize: 16, fontWeight: 'bold' },
  headerSub: { fontSize: 13, color: '#666', marginTop: 2 },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#e8e8e8',
    fontWeight: '600',
    fontSize: 14,
  },
  card: {
    margin: 8,
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hora: { width: 40, fontSize: 13, fontWeight: '600', color: '#333' },
  endereco: { flex: 1, fontSize: 13, color: '#555' },
  linha: { height: 1, backgroundColor: '#ddd', marginVertical: 6, marginLeft: 48 },
  stats: { flexDirection: 'row', gap: 12, marginTop: 8, paddingLeft: 48 },
  stat: { fontSize: 12, color: '#888' },
});
```

---

## Endpoint 3 — Obter Pontos GPS das Rotas

Retorna os pontos GPS sanitizados do histórico de rotas M7, prontos para renderização em mapa.

```
GET /rastreamento/historico/m7/rotas
```

### Exemplo de requisição

```
GET /rastreamento/historico/m7/rotas?cnpj=12.345.678/0001-99&chassi=9BWZZZ377VT004251&dataInicial=2026-05-01&dataFinal=2026-05-15
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Resposta de sucesso

- **Status:** `200 OK`
- **Content-Type:** `application/json`

```json
{
  "veiculo": {
    "codigo": 1042,
    "placa": "ABC-1234",
    "chassi": "9BWZZZ377VT004251"
  },
  "periodo": {
    "dataInicial": "2026-05-01",
    "dataFinal": "2026-05-15"
  },
  "totalPontos": 3180,
  "pontos": [
    {
      "latitude": -30.0277,
      "longitude": -51.2089,
      "velocidade": 65.2,
      "ignicao": true,
      "dataGps": "2026-05-01T08:14:00"
    },
    {
      "latitude": -30.0310,
      "longitude": -51.2145,
      "velocidade": 72.0,
      "ignicao": true,
      "dataGps": "2026-05-01T08:15:12"
    }
  ]
}
```

---

## Estrutura detalhada da resposta `/rotas`

### `veiculo` — Informações do veículo

| Campo    | Tipo     | Descrição                              |
|---------|----------|----------------------------------------|
| `codigo` | `number` | Código interno do veículo na API M7    |
| `placa`  | `string` | Placa do veículo                       |
| `chassi` | `string` | Chassi consultado                      |

### `periodo` — Período consultado

| Campo         | Tipo     | Descrição                          |
|--------------|----------|------------------------------------|
| `dataInicial` | `string` | Data inicial (`YYYY-MM-DD`)        |
| `dataFinal`   | `string` | Data final (`YYYY-MM-DD`)          |

### `totalPontos` — `number`

Total de pontos GPS retornados após sanitização (remoção de duplicatas, coordenadas inválidas e jitter GPS).

### `pontos` — Array de pontos GPS

| Campo        | Tipo      | Descrição                                        |
|-------------|-----------|--------------------------------------------------|
| `latitude`   | `number`  | Latitude em graus decimais                       |
| `longitude`  | `number`  | Longitude em graus decimais                      |
| `velocidade` | `number`  | Velocidade em km/h                               |
| `ignicao`    | `boolean` | `true` se a ignição estava ligada naquele ponto  |
| `dataGps`    | `string`  | Data/hora do ponto GPS (string ISO ou datetime)  |

> **Nota:** As coordenadas seguem o padrão convencional — `latitude` primeiro, `longitude` segundo. Diferente do GeoJSON (que inverte a ordem), aqui você pode usar diretamente com `react-native-maps`.

---

## Tipagem TypeScript (React Native / Expo)

```typescript
// types/rastreamento-m7.ts

export interface VeiculoM7 {
  codigo: number;
  placa: string;
  chassi: string;
}

export interface PeriodoM7 {
  dataInicial: string;
  dataFinal: string;
}

export interface PontoGpsM7 {
  latitude: number;
  longitude: number;
  velocidade: number;
  ignicao: boolean;
  dataGps: string;
}

export interface HistoricoM7RotasResponse {
  veiculo: VeiculoM7;
  periodo: PeriodoM7;
  totalPontos: number;
  pontos: PontoGpsM7[];
}
```

---

## Exemplos de consumo no React Native (Expo SDK 55)

### Serviço de API

```typescript
// services/rastreamento-m7.service.ts
import { HistoricoM7RotasResponse } from '../types/rastreamento-m7';

const BASE_URL = 'https://sua-api.com';

export async function obterRotasM7(
  token: string,
  cnpj: string,
  chassi: string,
  dataInicial: string, // 'YYYY-MM-DD'
  dataFinal: string,   // 'YYYY-MM-DD'
): Promise<HistoricoM7RotasResponse> {
  const params = new URLSearchParams({ cnpj, chassi, dataInicial, dataFinal });
  const response = await fetch(
    `${BASE_URL}/rastreamento/historico/m7/rotas?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    const erro = await response.json().catch(() => ({}));
    throw new Error(
      (erro as { message?: string }).message ?? 'Erro ao buscar histórico de rotas M7',
    );
  }

  return response.json() as Promise<HistoricoM7RotasResponse>;
}
```

### Uso com React Query

```typescript
import { useQuery } from '@tanstack/react-query';
import { obterRotasM7 } from '../services/rastreamento-m7.service';

function useRotasM7(
  token: string,
  cnpj: string,
  chassi: string,
  dataInicial: string,
  dataFinal: string,
) {
  return useQuery({
    queryKey: ['historico-rotas-m7', cnpj, chassi, dataInicial, dataFinal],
    queryFn: () => obterRotasM7(token, cnpj, chassi, dataInicial, dataFinal),
    enabled: !!token && !!cnpj && !!chassi && !!dataInicial && !!dataFinal,
    staleTime: 5 * 60 * 1000, // 5 minutos
  });
}
```

### Renderização no mapa com `react-native-maps`

```typescript
import MapView, { Polyline, Marker } from 'react-native-maps';
import { PontoGpsM7 } from '../types/rastreamento-m7';

function MapaHistoricoM7({ pontos }: { pontos: PontoGpsM7[] }) {
  // Coordenadas para a polilinha da rota
  const routeCoords = pontos.map((p) => ({
    latitude: p.latitude,
    longitude: p.longitude,
  }));

  // Ponto de início e fim
  const pontoInicio = pontos[0];
  const pontoFim = pontos[pontos.length - 1];

  // Região inicial centrada na rota
  const calcularRegiao = () => {
    if (pontos.length === 0) return undefined;
    const lats = pontos.map((p) => p.latitude);
    const lngs = pontos.map((p) => p.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: (maxLat - minLat) * 1.2 || 0.01,
      longitudeDelta: (maxLng - minLng) * 1.2 || 0.01,
    };
  };

  return (
    <MapView style={{ flex: 1 }} initialRegion={calcularRegiao()}>
      {/* Linha da rota */}
      {routeCoords.length > 1 && (
        <Polyline
          coordinates={routeCoords}
          strokeColor="#2563eb"
          strokeWidth={3}
        />
      )}

      {/* Marcador de início */}
      {pontoInicio && (
        <Marker
          coordinate={{ latitude: pontoInicio.latitude, longitude: pontoInicio.longitude }}
          title="Início"
          pinColor="green"
        />
      )}

      {/* Marcador de fim */}
      {pontoFim && pontoFim !== pontoInicio && (
        <Marker
          coordinate={{ latitude: pontoFim.latitude, longitude: pontoFim.longitude }}
          title="Fim"
          pinColor="red"
        />
      )}
    </MapView>
  );
}
```

### Filtrando pontos com ignição ligada / desligada

```typescript
// Apenas pontos com ignição ligada (veículo em movimento)
const pontosEmMovimento = pontos.filter((p) => p.ignicao);

// Apenas paradas (ignição desligada)
const pontosParado = pontos.filter((p) => !p.ignicao);
```

### Download e abertura do PDF

```typescript
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';

async function gerarRelatorioM7(
  token: string,
  cnpj: string,
  chassi: string,
  dataInicial: string,
  dataFinal: string,
): Promise<void> {
  const params = new URLSearchParams({ cnpj, chassi, dataInicial, dataFinal });
  const url = `${BASE_URL}/rastreamento/historico/m7/pdf?${params.toString()}`;

  const safeChassi = chassi.replace(/[^A-Za-z0-9_-]/g, '');
  const fileUri =
    FileSystem.documentDirectory +
    `historico-m7-${safeChassi}-${dataInicial}-${dataFinal}.pdf`;

  try {
    const download = await FileSystem.downloadAsync(url, fileUri, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (download.status !== 200) {
      Alert.alert('Erro', 'Não foi possível gerar o relatório PDF.');
      return;
    }

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(download.uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Relatório de Histórico M7',
      });
    } else {
      Alert.alert('Aviso', 'Compartilhamento não disponível neste dispositivo.');
    }
  } catch (error) {
    Alert.alert('Erro', 'Ocorreu um erro ao baixar o relatório.');
    console.error(error);
  }
}
```

---

## Respostas de erro

Todos os endpoints seguem o padrão NestJS de erros:

### 400 Bad Request — Parâmetros inválidos

```json
{
  "statusCode": 400,
  "message": [
    "cnpj should not be empty",
    "chassi should not be empty",
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

### 404 Not Found — Veículo não encontrado na plataforma M7

```json
{
  "statusCode": 404,
  "message": "Veículo não encontrado na plataforma M7",
  "error": "Not Found"
}
```

### 502 Bad Gateway — Falha na comunicação com a API M7

```json
{
  "statusCode": 502,
  "message": "Falha ao consultar veículo na API M7",
  "error": "Bad Gateway"
}
```

### 500 Internal Server Error

```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

---

## Notas de performance

- O endpoint `/resumo` é o mais leve dos três: uma única chamada à API M7 que retorna todos os trajetos do período, processados no backend. Use-o como **ponto de entrada** para telas de histórico.
- A resposta do `/rotas` pode conter **muitos pontos GPS** dependendo do período e da frequência de atualização do dispositivo M7. Para períodos de 31 dias, espere entre **3.000–15.000 pontos** após sanitização.
- O backend já aplica filtros automáticos para remover pontos duplicados, coordenadas inválidas (lat/lng zero ou fora de limites) e jitter GPS (pontos a menos de 15 metros em menos de 5 segundos).
- O endpoint `/pdf` pode demorar alguns segundos pois utiliza Puppeteer para renderizar o relatório. Exiba um **indicador de carregamento** durante a requisição.
- Recomenda-se utilizar `staleTime` no React Query para evitar requisições redundantes em navegações repetidas.

---

*Gerado em 22/05/2026 | API M7 Histórico v2*
