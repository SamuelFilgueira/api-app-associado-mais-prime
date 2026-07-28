# Implementação da Query de Número de Imóvel (housenumber)

> Documento gerado em 07/07/2026. Descreve a Query 4 adicionada ao fluxo de reverse geocoding.

---

## 1. SQL Adicionado

A nova consulta foi chamada internamente de **Query 4**. Ela é executada em **duas variantes** (tentativa com prefixo de banco, depois sem):

### Variante com prefixo de banco

```sql
SELECT housenumber, latitude, longitude
FROM `nominatim_rj`.`placex`
WHERE latitude  BETWEEN :lat - 0.0005 AND :lat + 0.0005
  AND longitude BETWEEN :lon - 0.0005 AND :lon + 0.0005
  AND housenumber IS NOT NULL
  AND address_street = :rua
  AND (address_city = :cidade OR address_city IS NULL)
  AND (address_suburb = :bairro OR address_suburb IS NULL)   -- somente se bairro foi encontrado
ORDER BY ((latitude - :lat) * (latitude - :lat) + (longitude - :lon) * (longitude - :lon)) ASC
LIMIT 3;
```

### Variante sem prefixo de banco (fallback de conexão)

```sql
SELECT housenumber, latitude, longitude
FROM `placex`
WHERE latitude  BETWEEN :lat - 0.0005 AND :lon + 0.0005
  AND longitude BETWEEN :lon - 0.0005 AND :lon + 0.0005
  AND housenumber IS NOT NULL
  AND address_street = :rua
  AND (address_city = :cidade OR address_city IS NULL)
  AND (address_suburb = :bairro OR address_suburb IS NULL)
ORDER BY ((latitude - :lat) * (latitude - :lat) + (longitude - :lon) * (longitude - :lon)) ASC
LIMIT 3;
```

### Parâmetros bind

Todos os valores são passados como **bind parameters** (nunca concatenados diretamente), prevenindo SQL injection:

| Parâmetro | Valor de exemplo | Origem |
|-----------|-----------------|--------|
| `:lat - 0.0005` | `-22.889384` | GPS latitude - raio |
| `:lat + 0.0005` | `-22.888384` | GPS latitude + raio |
| `:lon - 0.0005` | `-43.474887` | GPS longitude - raio |
| `:lon + 0.0005` | `-43.473887` | GPS longitude + raio |
| `:rua` | `"Rua Boiobi"` | Resultado da Query 1 (highway) |
| `:cidade` | `"Rio de Janeiro"` | cidadeOverride ou Query 3 |
| `:bairro` | `"Rio da Prata"` | Resultado da Query 2 (place) — omitido se null |

---

## 2. Ponto de Inserção no Fluxo

O fluxo completo agora é:

```
[Paralelo] Promise.all:
  ├─ Query 1 → highway → rua, cep
  ├─ Query 2 → place   → bairro
  └─ Query 3 → boundary → cidade (município)
         │
         ▼
  [Sequencial] Query 4 → housenumber
    (usa rua, cidade, bairro já resolvidos)
         │
         ▼
  Montagem do endereço:
    - Com número: "Rua Boiobi, 59, Rio da Prata, Rio de Janeiro, RJ, 21825-060"
    - Sem número: "Rua Boiobi, Rio da Prata, Rio de Janeiro, RJ, 21825-060"
```

**Arquivo modificado:** `src/rastreamento/m7/services/historico-m7.service.ts`

**Função modificada:** `buscarReverseGeocodeNominatimMysql`

**Posição no código:** Logo após o bloco `const cidade = ...` e antes de `const partes: string[] = []`.

---

## 3. Impacto Estimado em Desempenho

| Aspecto | Avaliação |
|---------|-----------|
| **Raio da query** | 0.0005° ≈ 50 m — bounding box muito pequeno |
| **Rows candidatos** | Estimativa: 0–5 registros por chamada (filtros de rua + cidade reduzem drasticamente) |
| **Execução** | Sequential após o `Promise.all`, adiciona ~1–3 ms por coordenada única |
| **Cache in-memory** | Não afeta — o cache retorna antes de chegar nessa função |
| **Deduplicação** | Não afeta — coordenadas iguais passam pelo cache in-memory |
| **Frequência real** | Só executa se `rua != null` (se Query 1 não encontrar rua, a Query 4 é pulada) |
| **Falha silenciosa** | Se a coluna `address_street` não existir, a query lança exceção que é capturada → zero custo adicional |

**Cenário típico de contestação (período de 5 dias):**
- ~3.400 pontos GPS brutos
- Deduplicados a ~300–600 coordenadas únicas (pontos parados repetem-se)
- Com cache in-memory: apenas as primeiras ~300 coordenadas executam queries SQL
- Query 4 adicionada: ~300 queries extras de ~1–3 ms cada → **≤ 1 segundo de custo adicional total**

---

## 4. Cenários em que Nenhum Número é Encontrado (mesmo existindo rua)

### 4.1 Ausência de `housenumber` no OSM para a rua

A base `nominatim_rj.placex` reflete o que foi mapeado no OpenStreetMap. Em muitas ruas do Rio de Janeiro, os números de imóveis simplesmente não foram adicionados ao OSM pelos colaboradores. Isso é comum em:
- Ruas residenciais de bairros populares
- Áreas periféricas ou de menor densidade de mapeamento OSM

### 4.2 Coluna `address_street` não existe ou tem nome diferente

Se o schema do banco `nominatim_rj` exportado não contém a coluna `address_street` (poderia ser `street`, `name` ou outro nome), todas as tentativas de query lançarão uma exceção SQL que é capturada silenciosamente → nenhum número é retornado, endereço permanece como estava.

**Diagnóstico:** Verificar se a coluna existe:
```sql
SHOW COLUMNS FROM nominatim_rj.placex LIKE 'address%';
```

### 4.3 Divergência no nome da rua (`address_street` ≠ `name` da highway)

A Query 1 retorna o campo `name` (ou `name_pt`) do registro de highway mais próximo (ex: `"Rua Boiobi"`). A Query 4 filtra por `address_street = :rua` esperando que os registros de housenumber tenham exatamente o mesmo valor.

Possíveis divergências:
- Query 1 retorna `"Rua Boiobi"` mas `address_street` tem `"R. Boiobi"` (abreviatura)
- Diferença de acentuação: `"Rua Cônego"` vs `"Rua Conego"`
- Diferença de caixa: `"RUA BOIOBI"` vs `"Rua Boiobi"` (MySQL utf8mb4 é case-insensitive por padrão, então isso geralmente não é problema)

### 4.4 Ponto GPS fora do raio de 50 m

O ponto GPS pode estar até 50 m da rua em linha reta (por imprecisão do GPS, offset de rota etc.). Se o imóvel mais próximo com `address_street = :rua` estiver além de 0.0005° (~50 m), não será retornado.

Solução (não implementada): aumentar `R_HOUSE` para 0.001° (~100 m) aceitando um pouco mais de ambiguidade.

### 4.5 Imóvel na mesma rua mas em cidade diferente

Se o OSM tiver registros com `address_city = "Nilópolis"` para uma rua que fisicamente fica em "Rio de Janeiro" (problema de dados), o filtro `address_city = :cidade` exclui esse registro. O campo `OR address_city IS NULL` mitiga parcialmente esse problema.

### 4.6 Apenas housenumber de trechos não adjacentes

Em ruas muito longas (ex: Av. Brasil), o bounding box de 50 m pode incluir housenumbers do lado oposto da rua ou de um trecho completamente diferente. O critério de menor distância euclidiana minimiza isso mas não elimina completamente.

### 4.7 Dados OSM incompletos ou desatualizados

A base `nominatim_rj` foi importada em um ponto específico no tempo. Novas construções ou renumerações de imóveis feitas após a importação não estarão presentes.

---

## Resumo

```
Antes: Rua Boiobi, Rio da Prata, Rio de Janeiro, RJ, 21825-060
Depois (com número): Rua Boiobi, 59, Rio da Prata, Rio de Janeiro, RJ, 21825-060
Depois (sem número): Rua Boiobi, Rio da Prata, Rio de Janeiro, RJ, 21825-060
```

A implementação é incremental, não quebra nenhum comportamento existente, e falha de forma completamente silenciosa em caso de erro ou ausência de dados.
