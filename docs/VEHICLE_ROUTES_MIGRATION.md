# GET /api/vehicles/:vehicleId/routes — Migração Frontend

## Breaking changes

### 1. Campos movidos para `summary`

```diff
- response.totalRoutes
- response.totalDistanceMeters
- response.totalDurationSeconds

+ response.summary.totalRoutes
+ response.summary.totalDistanceMeters
+ response.summary.totalDurationSeconds
```

### 2. Novos campos por rota

```diff
+ routes[].formattedDistance   // "21.8 km" ou "850 m" — pronto para exibir
+ routes[].formattedDuration   // "1h 42m" — pronto para exibir
+ routes[].mapCenter           // { lat, lng } — centro sugerido para o mapa
+ routes[].bounds              // { southWest: {lat,lng}, northEast: {lat,lng} }
+ routes[].segmentCount        // número de segmentos válidos
+ routes[].hasMovement         // boolean
+ routes[].status              // "completed" | "in_progress" | "idle"
+ routes[].segments[]          // array de segmentos individuais
```

### 3. `path` mais fiel à realidade

O `path` agora é construído a partir dos **segmentos reais** da trajetória.  
Antes vinha de um campo interno da API externa extremamente simplificado, causando linhas retas.  
O formato `[[lat, lng], ...]` **não mudou** — só a qualidade dos pontos melhorou.

Segmentos descartados automaticamente pelo servidor:
- `distância < 100 m`
- `duração < 30 s`

---

## Renderização no Leaflet

```js
// Polyline — sem mudança de formato
L.polyline(route.path, { color: '#2196F3', weight: 4 }).addTo(map);

// Zoom automático usando os bounds prontos
map.fitBounds([
  [route.bounds.southWest.lat, route.bounds.southWest.lng],
  [route.bounds.northEast.lat, route.bounds.northEast.lng],
], { padding: [40, 40] });

// Centralizar em uma rota específica
map.setView([route.mapCenter.lat, route.mapCenter.lng], 14);

// Marcadores de início e fim
L.marker([route.startPoint.lat, route.startPoint.lng]).addTo(map); // partida
L.marker([route.endPoint.lat,   route.endPoint.lng]).addTo(map);   // chegada

// Centralizar todas as rotas juntas
const allPoints = response.routes.flatMap(r => r.path);
map.fitBounds(allPoints, { padding: [40, 40] });
```

---

## Exemplo de resposta

```json
{
  "vehicleId": "9BW123456N1234567",
  "period": { "start": "2026-05-14", "end": "2026-05-20" },
  "summary": {
    "totalRoutes": 1,
    "totalDistanceMeters": 21800,
    "totalDurationSeconds": 6120
  },
  "routes": [
    {
      "trajectoryId": "abc-001",
      "startedAt": "2026-05-14T08:12:00.000Z",
      "endedAt": "2026-05-14T09:54:00.000Z",
      "durationSeconds": 6120,
      "distanceMeters": 21800,
      "formattedDistance": "21.8 km",
      "formattedDuration": "1h 42m",
      "averageSpeed": 42.3,
      "maxSpeed": 87.0,
      "startPoint": { "lat": -23.5505, "lng": -46.6333 },
      "endPoint":   { "lat": -23.6010, "lng": -46.6901 },
      "mapCenter":  { "lat": -23.5757, "lng": -46.6617 },
      "bounds": {
        "southWest": { "lat": -23.6100, "lng": -46.7012 },
        "northEast": { "lat": -23.5400, "lng": -46.6200 }
      },
      "segmentCount": 4,
      "pointCount": 93,
      "hasMovement": true,
      "status": "completed",
      "path": [
        [-23.5505, -46.6333],
        [-23.5512, -46.6341]
      ],
      "segments": [
        {
          "index": 0,
          "startPoint": { "lat": -23.5505, "lng": -46.6333 },
          "endPoint":   { "lat": -23.5601, "lng": -46.6450 },
          "startedAt": "2026-05-14T08:12:00.000Z",
          "endedAt":   "2026-05-14T08:34:00.000Z",
          "durationSeconds": 1320,
          "distanceMeters": 5400,
          "averageSpeed": 36.2,
          "maxSpeed": 72.0
        }
      ]
    }
  ]
}
```
