# Relatórios de rastreamento — endpoints externos e formato dos dados

Referência rápida das chamadas feitas às plataformas de rastreamento (M7, Lógica Soluções e Softruck)
para montar os relatórios: parâmetros, exemplos de requisição e resposta, conversão de endereços e a
estrutura dos PDFs.

Os valores dos exemplos são ilustrativos. Tokens e credenciais aparecem como `<placeholder>`. Só os
campos que os relatórios usam estão listados nas respostas.

---

## Sequência de chamadas por relatório

| Relatório | Chamadas, em ordem |
| --- | --- |
| Trajetórias M7 | `login` → `api/veiculos/consulta` → `api/monitorado/{codigo}/trajetos` |
| Rotas Detalhadas M7 (ponto a ponto) | `login` → `api/veiculos/consulta` → `api/historico/{inicio}/{fim}/{codigo}` → geocodificação reversa local |
| Trajetórias Lógica | `autentica` (quando o token é recusado) → `listaVeiculo` → `mobile/trajeto` |
| Trajetórias Softruck | `auth/login` → `vehicles?search` → `vehicles/{id}/associations/devices` → `trajectories/by-keys` (uma chamada por dia) |

A tela de histórico (mapa) do app usa ainda: M7 `api/veiculos/ultima-posicao`, Lógica `mobile/posicao`
e Softruck `trajectories/geom`. Estão documentados no fim de cada plataforma.

---

## M7

- **Base:** `{M7_API_BASE_URL}` (termina com `/`).
- **Autenticação:** `Authorization: Bearer <token>` em todas as chamadas, exceto no login.
- **Token inválido:** HTTP 401, ou corpo com `mensagem` contendo "token". Fazer login de novo e repetir a chamada.
- **Datas:** `YYYY-MM-DD` na URL; as respostas trazem `YYYY-MM-DD HH:mm:ss` em horário local (America/Sao_Paulo).

### 1. Login

```http
POST {M7_API_BASE_URL}login
Content-Type: application/json

{ "codigo": "<código do cliente M7>", "api_m7_token": "<token de API M7>" }
```

```json
{ "sucesso": true, "token": "<token>", "expires_in": "<validade>" }
```

`sucesso` diferente de `true` = login recusado.

### 2. Consulta do veículo

Traduz documento + chassi no código interno do veículo.

```http
POST {M7_API_BASE_URL}api/veiculos/consulta
Authorization: Bearer <token>
Content-Type: application/json

{ "cnpj": "<CPF ou CNPJ do titular>", "chassi": "9BWZZZ377VT004251" }
```

```json
{
  "veiculo": { "codigo": 48213, "placa": "ABC1D23", "chassi": "9BWZZZ377VT004251" },
  "cliente": { "codigo": 911 }
}
```

`veiculo.codigo` é o `{codigo}` das próximas chamadas. Sem `veiculo.codigo` = veículo não encontrado.

### 3. Trajetos (viagens e paradas já consolidadas)

```http
GET {M7_API_BASE_URL}api/monitorado/48213/trajetos?data_inicio=2026-09-28 00:00:00&data_fim=2026-10-02 00:00:00
Authorization: Bearer <token>
```

- `data_inicio`: primeiro dia, `00:00:00`.
- `data_fim`: **dia seguinte** ao último dia desejado, `00:00:00` (o fim é exclusivo). Para 28/09 a 01/10, mandar `2026-10-02 00:00:00`.
- Depois, descartar localmente os itens cujo `data_inicio` (ou `data_fim`) cai fora do período pedido.

```json
{
  "trajetos": [
    {
      "id": 1,
      "tipo": "PARADO",
      "data_inicio": "2026-09-28 00:00:00",
      "data_fim": "2026-09-28 07:41:12",
      "tempo_movimento": "00:00:00",
      "tempo_parado": "07:41:12",
      "tempo_total": "07:41:12",
      "distancia": "0",
      "velocidade_maxima": 0,
      "destino": "Rua Exemplo, Tijuca, Rio de Janeiro - RJ, Brasil"
    },
    {
      "id": 2,
      "tipo": "VIAGEM",
      "data_inicio": "2026-09-28 07:41:12",
      "data_fim": "2026-09-28 08:20:03",
      "tempo_movimento": "00:31:40",
      "tempo_parado": "00:07:11",
      "tempo_total": "00:38:51",
      "distancia": "14.2",
      "velocidade_maxima": 78,
      "destino": "Av. Exemplo, Centro, Rio de Janeiro - RJ, Brasil"
    }
  ]
}
```

- `tipo`: `VIAGEM` ou `PARADO`.
- `distancia`: km (string ou número). `velocidade_maxima`: km/h. Tempos: `HH:MM:SS`.
- `destino`: endereço em texto, pronto para exibir; pode vir vazio.

### 4. Histórico GPS (ponto a ponto)

```http
GET {M7_API_BASE_URL}api/historico/2026-09-28/2026-10-02/48213
Authorization: Bearer <token>
```

Formato da URL: `api/historico/{dataInicial}/{dataFinal + 1 dia}/{codigo}`. Mesmo filtro local por
`data_gps` do item anterior. Volume alto: um carro que roda o dia todo gera dezenas de milhares de pontos
em poucos dias.

```json
{
  "historico": [
    {
      "codigo_posicao": 99120345,
      "identificador": "ABC1D23",
      "monitorado": 48213,
      "data_gps": "2026-09-28 07:41:12",
      "data_sistema": "2026-09-28 07:41:15",
      "cidade": "RIO DE JANEIRO, RJ",
      "latitude": "-22.903512",
      "longitude": "-43.209876",
      "velocidade": 42,
      "odometro": "18342.7",
      "ignicao": true,
      "tensao": "12.6",
      "bateria": "100"
    }
  ]
}
```

- `latitude`/`longitude`: string ou número; podem vir com vírgula decimal.
- `ignicao`: booleano, `0`/`1` ou texto (`"ligado"`).
- `identificador`: placa. `cidade`: `"CIDADE, UF"`, em maiúsculas.

### 5. Última posição (só tela de histórico)

```http
POST {M7_API_BASE_URL}api/veiculos/ultima-posicao
Authorization: Bearer <token>
Content-Type: application/json

{ "cnpj": "<CPF ou CNPJ do titular>", "chassi": "9BWZZZ377VT004251" }
```

```json
{
  "ultima_posicao": {
    "monitorado": 48213,
    "data_gps": "2026-10-01 18:02:44",
    "latitude": "-22.911203",
    "longitude": "-43.220871",
    "velocidade": 0,
    "ignicao": false,
    "cidade": "RIO DE JANEIRO, RJ",
    "marca": "VW",
    "modelo": "GOL",
    "identificador": "ABC1D23",
    "tensao": "12,4"
  }
}
```

Na tela de histórico, `ultima_posicao.monitorado` é usado como `{codigo}` em `trajetos` e `historico`.
Nos PDFs, o código vem de `veiculos/consulta`.

---

## Lógica Soluções

- **Bases:** `{LOGICA_API_BASE_URL}` para `autentica` e `listaVeiculo`;
  `https://monitoramento.logicasolucoes.com.br/mobile/...` para `trajeto` e `posicao`.
- **Formato:** todas as chamadas são `POST` com `Content-Type: application/x-www-form-urlencoded`.
- **Autenticação:** o token vai no corpo, no campo `token`.
- **Token inválido:** não vem como 401. A resposta é **HTTP 200** com `logado: false`, `erro: true`, ou
  `mensagem` contendo "token" e "inválido"/"expirado". Autenticar de novo e repetir a chamada.
- **Datas:** envio em `dd/MM/yyyy HH:mm`; respostas em `dd/MM/yyyy HH:mm:ss`, horário local.

### 1. Autenticação

```http
POST {LOGICA_API_BASE_URL}/autentica
Content-Type: application/x-www-form-urlencoded

usuario=<número da API>&senha=<número da API>
```

```json
{ "erro": false, "logado": true, "token": "<token>" }
```

Login recusado volta como HTTP 200 com `{ "erro": true, "logado": false, "token": "" }`. Isso também
acontece quando há vários logins seguidos; esperar alguns segundos (2 s, 4 s, 6 s) e tentar de novo
resolve. `usuario` e `senha` recebem o mesmo valor.

### 2. Lista de veículos (chassi → id)

```http
POST {LOGICA_API_BASE_URL}/listaVeiculo
Content-Type: application/x-www-form-urlencoded

chassi=9BWZZZ377VT004251&token=<token>
```

```json
{
  "lista": [
    { "id": 5521, "chassi": "9BWZZZ377VT004251", "placa": "ABC1D23", "marca": "VW", "modelo": "Gol" }
  ]
}
```

Usar o item cujo `chassi` é idêntico ao pedido. `id` é o `veiculoId` da próxima chamada. Sem item =
veículo não encontrado.

### 3. Trajeto (posições, paradas e resumo do período)

```http
POST https://monitoramento.logicasolucoes.com.br/mobile/trajeto
Content-Type: application/x-www-form-urlencoded

veiculoId=5521&dataInicio=28/09/2026 00:00&dataFim=01/10/2026 23:59&token=<token>
```

O período inteiro vai numa chamada: `00:00` do primeiro dia até `23:59` do último.

```json
{
  "clienteNome": "Cliente Exemplo",
  "logado": true,
  "quantidadeTotal": 2,
  "relatorio": {
    "posicoes": [
      {
        "data": "28/09/2026 07:41:12",
        "latitude": -22.903512,
        "longitude": -43.209876,
        "velocidade": 42,
        "ignicao": "LIGADA",
        "direcao": "NORTE",
        "endereco": "Rua Exemplo, 120 - Tijuca - Rio de Janeiro/RJ",
        "enderecoEndereco": "Rua Exemplo",
        "enderecoNumero": "120",
        "enderecoBairro": "Tijuca",
        "enderecoCidade": "Rio de Janeiro",
        "enderecoEstado": "RJ",
        "placa": "ABC1D23",
        "satelite": 9
      }
    ],
    "paradas": [
      {
        "tipo": "Parada",
        "data": "28/09/2026 08:20:03",
        "dataInicio": "28/09/2026 08:20:03",
        "dataFim": "28/09/2026 08:33:51",
        "tempo": "00:13:48",
        "latitude": -22.910121,
        "longitude": -43.220703,
        "velocidade": 0,
        "ignicao": "DESLIGADA",
        "endereco": "Av. Exemplo, 500 - Centro - Rio de Janeiro/RJ"
      }
    ],
    "resumo": {
      "distanciaTotal": 58.31,
      "tempoIgnicaoLigada": "03:12:40",
      "tempoMotorOcioso": "00:21:05",
      "tempoParado": "05:10:00",
      "tempoMovimento": "02:51:35",
      "velocidadeMaxima": 92,
      "velocidadeMedia": 27,
      "velocidadeMinima": 0,
      "quantidadeParada": 12,
      "quantidadeDeslocamento": 11
    },
    "eventoMotorista": []
  }
}
```

- `ignicao`: `"LIGADA"`, `"DESLIGADA"` ou vazio.
- `resumo.distanciaTotal`: km. Velocidades: km/h. Tempos: `HH:MM:SS`.
- Em dias já consolidados, `posicoes[]` pode vir com poucos pontos. Para a trilha completa, usar `mobile/posicao`.

### 4. Posição (trilha completa — só tela de histórico)

Mesma requisição do `mobile/trajeto`, no endereço `.../mobile/posicao`.

```json
{
  "relatorio": [
    {
      "data": "2026-09-28 07:41:12.933",
      "dataTz": 1790592072933,
      "latitude": -22.903512,
      "longitude": -43.209876,
      "velocidade": 42,
      "ignicao": "LIGADA",
      "posicaoValida": true,
      "equipamentoCodigo": "<código do rastreador>",
      "eventoNome": null
    }
  ]
}
```

- O corpo real vem como **JSON inválido**: as datas chegam sem aspas (`"data":2026-09-28 07:41:12.933`).
  Ler como texto e aplicar, antes do `JSON.parse`, a troca
  `:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)` → `:"$1"`.
- `dataTz`: epoch em milissegundos. `posicaoValida: false` = leitura sem sinal de GPS; descartar.
- As posições não trazem endereço. Cerca de 2 MB por dia.

---

## Softruck

- **Base:** `{SOFTRUCK_API_BASE_URL}` = `https://api.softruck.com/v2`.
- **Headers em todas as chamadas:** `public-key: <chave pública>`; e, exceto no login, `Authorization: Bearer <token>`.
- **Token inválido:** HTTP 401 ou 403. Fazer login de novo e repetir.
- **Datas:** o dia vai como `acc` no formato `YYYYMMDD`; as respostas trazem ISO 8601 com offset
  (`2026-09-28T07:41:12-03:00`) ou epoch em segundos (no `geom`).

### 1. Login

```http
POST https://api.softruck.com/v2/auth/login
public-key: <chave pública>
Content-Type: application/json

{ "username": "<usuário>", "password": "<senha>" }
```

```json
{ "data": { "token": "<jwt>", "refresh_token": "<refresh token>" } }
```

A validade está no claim `exp` do JWT.

### 2. Veículo (chassi → vehicleId)

```http
GET https://api.softruck.com/v2/vehicles?search=9BWZZZ377VT004251
Authorization: Bearer <jwt>
public-key: <chave pública>
```

```json
{
  "data": [
    {
      "id": "5paxZx5VNEwWbP3",
      "attributes": { "plate": "ABC1D23", "brand_name": "Volkswagen", "model_name": "Gol" }
    }
  ]
}
```

`data[0].id` é o `vehicleId`. Lista vazia = veículo não está na Softruck.

### 3. Dispositivo associado (vehicleId → deviceId)

```http
GET https://api.softruck.com/v2/vehicles/5paxZx5VNEwWbP3/associations/devices
Authorization: Bearer <jwt>
public-key: <chave pública>
```

```json
{
  "data": [
    {
      "id": "1aN6LqvB5mQEY4O",
      "attributes": { "created_at": "2025-11-03T14:22:10Z", "is_main_device": true, "deleted_at": null },
      "relationships": {
        "device": { "id": "RY2PZgKPdMZejAx" },
        "vehicle": { "id": "5paxZx5VNEwWbP3" }
      }
    }
  ]
}
```

Entre as associações com `is_main_device: true`, usar a de `created_at` mais recente.
`relationships.device.id` é o `deviceId`.

### 4. Trajetória do dia (`by-keys`)

Uma chamada **por dia** do período.

```http
GET https://api.softruck.com/v2/vehicles/5paxZx5VNEwWbP3/trajectories/by-keys?filters[acc][eq]=20260928&filters[did][eq]=RY2PZgKPdMZejAx
Authorization: Bearer <jwt>
public-key: <chave pública>
```

```json
{
  "data": {
    "id": "<id da trajetória do dia>",
    "attributes": {
      "acc": 20260928,
      "dur": 11520,
      "dis": 58310,
      "spMax": 92,
      "spAvg": 27,
      "sgCnt": 4,
      "stCnt": 6,
      "stDur": 1810,
      "alCnt": 1,
      "segs": [
        {
          "id": "<id do segmento>",
          "sta": { "act": "2026-09-28T07:41:12-03:00", "lat": -22.903512, "lng": -43.209876, "adr": "Rua Exemplo, Tijuca" },
          "end": { "act": "2026-09-28T08:20:03-03:00", "lat": -22.910121, "lng": -43.220703, "adr": "Av. Exemplo, Centro" },
          "dur": 2331,
          "dis": 14200,
          "spMax": 78,
          "spAvg": 36,
          "stCnt": 2,
          "stDur": 431,
          "alCnt": 0
        }
      ]
    },
    "relationships": {
      "enterprise": { "id": "<enterpriseId>" },
      "device": { "id": "RY2PZgKPdMZejAx" },
      "vehicle": { "id": "5paxZx5VNEwWbP3" }
    }
  }
}
```

- `dur`: segundos. `dis`: metros. `spMax`/`spAvg`: km/h. `adr`: endereço em texto, opcional.
- Erro ou corpo vazio num dia = dia sem viagens; os outros dias seguem normalmente.
- `relationships.enterprise.id` é exigido pelo `geom`.

### 5. Pontos do dia (`geom` — só tela de histórico)

```http
GET https://api.softruck.com/v2/vehicles/5paxZx5VNEwWbP3/trajectories/geom?filters[acc][eq]=20260928&filters[did][eq]=RY2PZgKPdMZejAx&filters[eid][eq]=<enterpriseId>
Authorization: Bearer <jwt>
public-key: <chave pública>
```

```json
{
  "data": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": {
          "type": "DETAILED",
          "point": { "did": "RY2PZgKPdMZejAx", "acc": 20260928, "lat": -22.903512, "lng": -43.209876,
                     "ign": true, "spd": 42, "dir": 180, "act": 1790592072, "tag": "gps", "val": "", "msg": "" }
        },
        "geometry": { "type": "Point", "coordinates": [-43.209876, -22.903512] }
      },
      {
        "type": "Feature",
        "properties": {
          "type": "ALARM", "tag": "<tipo do alarme>", "val": "<valor>", "msg": "<mensagem>",
          "point": { "did": "RY2PZgKPdMZejAx", "acc": 20260928, "lat": -22.91, "lng": -43.22, "act": 1790594403 }
        },
        "geometry": { "type": "Point", "coordinates": [-43.22, -22.91] }
      }
    ]
  }
}
```

- `DETAILED` = ponto de trajeto; `ALARM` = evento.
- `point.act`: epoch em segundos. `geometry.coordinates`: `[longitude, latitude]`.

---

## Conversão de endereços

| Relatório | De onde vem o endereço |
| --- | --- |
| Trajetórias M7 | Campo `destino` de cada item de `trajetos` (texto pronto da M7); vazio → `—` |
| Rotas Detalhadas M7 | Geocodificação reversa local, descrita abaixo |
| Trajetórias Lógica | Campo `endereco` de cada posição ou parada; vazio → `—` |
| Trajetórias Softruck | `sta.adr` / `end.adr` de cada segmento; vazio → `lat, lng` com 5 casas |

### Geocodificação reversa local (Rotas Detalhadas M7)

A M7 não devolve endereço por ponto. O endereço é calculado numa base Nominatim local do RJ em MySQL
(tabela `placex`), que tem as colunas adicionais `address_street`, `address_suburb` e `address_city`.

1. **Normalizar** latitude e longitude com 6 casas decimais (vírgula vira ponto).
2. **Reduzir o número de consultas:**
   - manter 1 ponto a cada 10 s (primeiro e último sempre ficam);
   - ponto a até 20 m de outro já resolvido, na mesma cidade, reaproveita o endereço dele;
   - consultar o cache Redis antes do banco, com a chave
     `m7:revgeo:v1:{round(lat × 10000)}:{round(lon × 10000)}:{cidade-normalizada}` (TTL de 7 dias,
     renovado a cada acerto).
3. **Consultar o banco**, três buscas por caixa de coordenadas, ordenadas pela distância:

    ```sql
    -- Rua: via mais próxima, raio ±0,005° (~550 m)
    SELECT name, name_pt, type, address_suburb, address_city
    FROM nominatim_rj.placex
    WHERE latitude  BETWEEN :lat - 0.005 AND :lat + 0.005
      AND longitude BETWEEN :lon - 0.005 AND :lon + 0.005
      AND class = 'highway'
    ORDER BY (latitude - :lat) * (latitude - :lat) + (longitude - :lon) * (longitude - :lon)
    LIMIT 3;

    -- Bairro: raio ±0,03°
    ... AND class = 'place' AND type IN ('quarter', 'neighbourhood', 'suburb') ... LIMIT 5;

    -- Cidade: raio ±0,5°
    ... AND class = 'boundary' AND type = 'administrative' AND admin_level = 8 ... LIMIT 1;
    ```

4. **Número predial**, só se achou rua: imóvel mais próximo num raio de ±0,0005° (~55 m) com
   `housenumber` preenchido, na mesma rua, cidade e bairro.

    ```sql
    SELECT housenumber, latitude, longitude
    FROM nominatim_rj.placex
    WHERE latitude  BETWEEN :lat - 0.0005 AND :lat + 0.0005
      AND longitude BETWEEN :lon - 0.0005 AND :lon + 0.0005
      AND housenumber IS NOT NULL
      AND address_street = :rua
      AND (address_city = :cidade OR address_city IS NULL)
      AND (address_suburb = :bairro OR address_suburb IS NULL)
    ORDER BY (latitude - :lat) * (latitude - :lat) + (longitude - :lon) * (longitude - :lon)
    LIMIT 3;
    ```

5. **Montar o texto** `Rua, nº, Bairro, Cidade, RJ`:
   - rua = `name_pt` (ou `name`) da via mais próxima;
   - bairro = `address_suburb` da via; senão o primeiro `quarter`, depois `neighbourhood`, depois `suburb`;
   - cidade = campo `cidade` da M7 normalizado (`"RIO DE JANEIRO, RJ"` → `"Rio de Janeiro"`); senão
     `address_city` da via; senão o limite municipal; senão `"Rio de Janeiro"`.
6. **Sem rua e sem bairro**, ou passados 90 s de geocodificação na requisição: o endereço fica
   `"lat, lon"`. Esse valor não vai para o Redis.

Exemplo: `(-22.903512, -43.209876, "RIO DE JANEIRO, RJ")` → `Rua Exemplo, 120, Tijuca, Rio de Janeiro, RJ`.

---

## PDF

**Bibliotecas:**

- **Puppeteer** (HTML + CSS impresso pelo Chromium headless) para Trajetórias M7, Trajetórias Lógica e
  Trajetórias Softruck. O PDF fica pronto inteiro e é devolvido de uma vez.
- **pdfkit** (desenho direto, sem navegador) para Rotas Detalhadas M7. Cada página é enviada na
  resposta assim que fica pronta (streaming), porque o relatório pode ter milhares de linhas.

**Estrutura comum:** A4 paisagem; cabeçalho com logo, título e "Gerado em"; cards de identificação do
veículo e do período; cards de resumo; tabela com cabeçalho escuro e linhas zebradas; rodapé.

| Relatório | Uma linha da tabela é… | Seções e colunas |
| --- | --- | --- |
| Trajetórias M7 | Um item de `trajetos` (viagem ou parada), agrupado por dia | Cards: Placa, Chassi, Período. Resumo: dias com dados, total, distância, velocidade máxima. Gráfico de itens por dia e top 8 destinos. Tabela: Saída, Chegada, Tipo, Destino, Tempo, Distância, Vel. Máx., com uma linha de título por dia |
| Rotas Detalhadas M7 | Um ponto de `historico` (1 a cada 10 s) com endereço | Cards: Placa, Chassi, Período inicial, Período final. Aviso sobre o intervalo de 10 s. Tabela: Data, Hora, Velocidade, Endereço, Latitude, Longitude |
| Trajetórias Lógica | Uma posição ou parada de `mobile/trajeto`, em ordem de data | Cards: Chassi, ID do veículo, Período; total de posições, primeiro e último registro. Resumo da própria Lógica: distância, tempo de ignição ligada, velocidade média e máxima, motor ocioso. Tabela: Data, KM/H, Ignição, Posição, Endereço |
| Trajetórias Softruck | Um segmento (`segs[]`) do `by-keys` | Cards: Placa, Veículo (marca + modelo), Chassi. Resumo: trajetos, distância, tempo em movimento, velocidade máxima e média (ponderada pela distância), dias com dados. Gráfico de trajetos por dia e top 8 endereços. Tabela: Início, Fim, Duração, Distância, Vel. Média, Vel. Máxima, Endereço inicial, Endereço final |

Na linha do tempo da Lógica, cada parada entra como uma posição na data de início; itens com mesma
data e coordenada aparecem uma vez só, e a ignição vazia repete o último valor conhecido.
