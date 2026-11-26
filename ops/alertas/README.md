# Alertas da Benefícios API

`regras.yml` traz as regras de alerta da aplicação no formato do Prometheus
(`groups:`). O mesmo arquivo serve para VictoriaMetrics (`vmalert`) e para o
ruler do Grafana Mimir.

## Como carregar

1. **Coleta.** Todo processo expõe `GET /metrics` na porta 3001. `worker` e
   `pdf` não publicam porta no host, então o coletor precisa estar na rede do
   compose (um container no mesmo projeto) e ler pelos nomes dos serviços. O
   nome do job precisa ser `beneficios-api` (a regra `AlvoForaDoAr` filtra por
   ele). O rótulo `role` não precisa ser configurado: a aplicação já o põe em
   todas as séries.

   ```yaml
   scrape_configs:
     - job_name: beneficios-api
       metrics_path: /metrics
       # Só se METRICS_TOKEN estiver definido no .env da API. Sem a env, a API
       # responde a IP privado (a rede do Docker) sem token.
       # authorization:
       #   credentials_file: /etc/prometheus/metrics_token
       static_configs:
         - targets: ["api-1:3001", "api-2:3001", "worker:3001", "pdf:3001"]
   ```

2. **Regras.** Aponte o `rule_files` para este arquivo e recarregue:

   ```yaml
   rule_files:
     - /etc/prometheus/regras/beneficios-api.yml   # cópia ou bind de ops/alertas/regras.yml
   ```

   ```bash
   promtool check rules ops/alertas/regras.yml      # sempre antes de aplicar
   curl -X POST http://localhost:9090/-/reload      # ou SIGHUP no processo
   ```

3. **Destino.** As regras só marcam `severity` (`critical` ou `warning`) e
   `servico`. Quem recebe o quê (e-mail, WhatsApp, plantão) é rota do
   Alertmanager, fora deste repositório.

O `/metrics` nunca sai pela internet: o Nginx devolve 404
(`ops/nginx/beneficios-api.conf`).

## O que estas regras cobrem

| Grupo | Alertas |
|---|---|
| `http` | taxa de 5xx acima de 2%, p95 acima de 2 s |
| `processo` | alvo fora do ar, event loop atrasado, memória e heap perto do teto, ciclo de reinício |
| `filas` | fila parada (120 s em `webhook-events` e `notifications`, 600 s nas demais), fila de mortos |
| `vendors` | taxa de falha acima de 20%, circuito aberto |
| `hinova` | falha de autenticação no SGA, token bloqueado |
| `rotinas` | régua de boletos sem rodar há 26 h, disparo de marketing preso em envio |
| `complementares` | erro não tratado no processo, rate limit sem Redis |

Os tetos de memória e de heap estão escritos em valor absoluto por papel. Se o
`mem_limit` ou o `NODE_OPTIONS` mudar no `docker-compose.escala.yml`, mude nas regras
`MemoriaDoProcessoAlta`, `MemoriaDoProcessoAltaPdf` e `HeapDoNodeAlto`.

## O que NÃO está aqui: infraestrutura

Redis, MySQL, disco e o container como um todo não aparecem no `/metrics` da
aplicação. Dependem de exporters instalados à parte. As expressões abaixo são
sugestões de partida, escritas com os nomes de métrica de cada exporter —
**não foram testadas neste ambiente**; confira os nomes na versão instalada.

### Redis — `redis_exporter`

O Redis roda com `maxmemory 1gb` e `noeviction` (exigência do BullMQ): cheio,
ele recusa escrita e as filas param. É o alerta de infraestrutura mais
importante deste deploy.

```yaml
- alert: RedisForaDoAr
  expr: redis_up == 0
  for: 1m

- alert: RedisMemoriaAlta            # 80% do maxmemory
  expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.80
  for: 10m

- alert: RedisRecusandoConexao
  expr: increase(redis_rejected_connections_total[5m]) > 0

- alert: RedisSemPersistencia        # último AOF/RDB falhou
  expr: redis_aof_last_write_status == 0 or redis_rdb_last_bgsave_status == 0
  for: 5m
```

### MySQL/MariaDB — `mysqld_exporter`

Os quatro processos somam 32 conexões de pool do Prisma (10 + 10 + 10 + 2),
mais a do `migrate` durante o deploy. O alerta de conexões mostra quando esse
orçamento estoura; fila DENTRO do pool do Prisma (erro P2024 no log da API)
não aparece aqui — o MySQL nem chega a ver a conexão.

```yaml
- alert: MysqlForaDoAr
  expr: mysql_up == 0
  for: 1m

- alert: MysqlConexoesPertoDoLimite  # 80% de max_connections
  expr: mysql_global_status_threads_connected / mysql_global_variables_max_connections > 0.80
  for: 5m

- alert: MysqlConexoesRecusadas
  expr: increase(mysql_global_status_connection_errors_total{error="max_connections"}[5m]) > 0

- alert: MysqlConsultasLentas
  expr: rate(mysql_global_status_slow_queries[5m]) > 0.1
  for: 10m
```

### Host e disco — `node_exporter`

O disco guarda uploads, releases OTA, o AOF do Redis, os dados do MySQL e os
logs dos containers (limitados a 5 × 20 MB por container no compose).

```yaml
- alert: DiscoQuaseCheio             # menos de 15% livre
  expr: |
    node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}
      / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"} < 0.15
  for: 15m

- alert: DiscoEncheEm24h
  expr: predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}[6h], 24 * 3600) < 0
  for: 1h

- alert: MemoriaDoHostBaixa          # menos de 10% disponível
  expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
  for: 10m

- alert: CpuDoHostSaturada           # carga acima do nº de vCPUs
  expr: node_load5 > count without (cpu, mode) (node_cpu_seconds_total{mode="idle"})
  for: 15m
```

### Container inteiro — cAdvisor

`process_resident_memory_bytes` é só o processo Node. No serviço `pdf` quase
toda a memória é do Chromium, que só aparece na medição do container. Também é
o cAdvisor que conta as mortes por falta de memória.

```yaml
- alert: ContainerPertoDoTetoDeMemoria   # 90% do mem_limit
  expr: |
    container_memory_working_set_bytes{name=~".*-(api-1|api-2|worker|pdf|redis)-1"}
      / container_spec_memory_limit_bytes{name=~".*-(api-1|api-2|worker|pdf|redis)-1"} > 0.90
  for: 5m

- alert: ContainerMortoPorFaltaDeMemoria
  expr: increase(container_oom_events_total{name=~".*-(api-1|api-2|worker|pdf|redis)-1"}[10m]) > 0
```

### Borda — Nginx

O log de acesso do site já sai em JSON com `request_id`, `status`,
`upstream_addr` e tempos (`ops/nginx/beneficios-api.conf`). Para alertar sobre
429 e 502 da borda — que a aplicação não enxerga, porque a requisição nem
chega a ela — é preciso transformar esse log em métrica (Grafana Alloy/Loki,
Vector ou `nginx-prometheus-exporter` com `stub_status`).
