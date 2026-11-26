# Testes de carga (k6) — linha de base

Três roteiros para medir a API antes e depois de mudanças de arquitetura. O
objetivo é ter números de referência — quanto a VPS aguenta e onde ela quebra
primeiro —, não aprovar ou reprovar um build.

| Roteiro | O que simula | Pergunta que responde |
|---|---|---|
| `abertura-do-app.js` | login → `/api/auth/me` → `/api/sga/associado` → `/api/sga/veiculos` → `/api/sga/boleto/listar` | Quantas aberturas por segundo a API sustenta dentro do p95? |
| `polling-posicao.js` | `POST /api/rastreamento` a cada 5 s por aparelho | Quantas telas de rastreamento abertas ao mesmo tempo? |
| `pdf-simultaneo.js` | rampa em degraus de PDFs simultâneos | Qual é o teto de PDFs em paralelo antes de 504 ou falta de memória? |

## Só em homologação, com os vendors simulados

**Nunca rode contra produção.** Além de derrubar o serviço para os associados:

- cada abertura e cada consulta de posição vira chamada à Hinova/SGA, M7,
  Softruck e Lógica. A Hinova bloqueia o token da base por "extração de
  dados/comportamento agressivo" (`docs/HINOVA_BLOQUEIO_TOKEN_PROTECOES.md`), e
  o bloqueio atinge todos os associados da base;
- com vendor real, o que se mede é a latência do vendor, não a da API.

O ambiente de homologação precisa de:

- a mesma topologia que estiver em produção (para a de escala, `docker-compose.escala.yml`: 2 réplicas, worker, pdf,
  com os mesmos limites de CPU e memória) e um banco com volume parecido;
- os vendors trocados por simuladores que respondam com latência realista
  (o roteiro não sobe simulador nenhum);
- usuários de teste que já passaram pelo primeiro login, com veículo.

Os roteiros se recusam a rodar sem `-e AMBIENTE=homologacao`. É uma trava contra
engano, não uma garantia: quem define o `BASE_URL` é você.

## Como rodar

Com a imagem oficial (`grafana/k6`), montando esta pasta em `/scripts`:

```bash
docker run --rm -i --network host \
  -v "$PWD/test/carga:/scripts:ro" \
  -e AMBIENTE=homologacao \
  -e BASE_URL=http://127.0.0.1:3001 \
  -e CPF=00000000000 -e SENHA='senha-de-teste' \
  -e CHASSI=9BWZZZ377VT004251 -e CNPJ='00.000.000/0001-00' \
  grafana/k6 run /scripts/abertura-do-app.js
```

Troque o último argumento por `/scripts/polling-posicao.js` ou
`/scripts/pdf-simultaneo.js`. Anote a versão do k6 usada junto com os
resultados (`docker run --rm grafana/k6 version`) e fixe a tag da imagem nas
rodadas seguintes, para comparar igual com igual.

`--network host` permite apontar para `127.0.0.1` quando o gerador roda na
mesma máquina. O ideal é o gerador em **outra** máquina: na mesma VPS o k6
disputa CPU com a API e piora os números.

### Variáveis

| Variável | Onde | Descrição |
|---|---|---|
| `AMBIENTE` | todos | precisa ser `homologacao` |
| `BASE_URL` | todos | raiz da API, sem `/api` (padrão `http://localhost:3001`) |
| `CPF`, `SENHA` | todos | usuário de teste (o login usa `{ cpf, password }`) |
| `CHASSI`, `CNPJ` | polling, pdf | veículo consultado (`CNPJ` só é exigido no polling e nos PDFs da M7) |
| `USUARIOS_ARQUIVO` | todos | JSON com vários usuários, no lugar das quatro acima |
| `P95_MS`, `P95_LOGIN_MS`, `P95_PDF_MS`, `TAXA_ERRO_MAX` | — | limites dos thresholds |

As específicas de cada roteiro (taxa, VUs, duração, provedor do PDF) estão no
cabeçalho do arquivo.

### Vários usuários (`USUARIOS_ARQUIVO`)

Com um único CPF, todos os VUs são o mesmo associado: o cache responde por
todos e os limites por usuário da própria API entram em cena. Para uma medida
fiel, use um arquivo com vários usuários — cada VU pega um, em rodízio:

```bash
cp test/carga/usuarios.exemplo.json test/carga/usuarios.json   # preencha; não é versionado
docker run --rm -i --network host -v "$PWD/test/carga:/scripts:ro" \
  -e AMBIENTE=homologacao -e BASE_URL=http://127.0.0.1:3001 \
  -e USUARIOS_ARQUIVO=/scripts/usuarios.json -e MAX_SIMULTANEOS=8 \
  grafana/k6 run /scripts/pdf-simultaneo.js
```

No `pdf-simultaneo.js` isso é obrigatório na prática: a política `relatorio`
permite **um PDF por vez e 3 por minuto por usuário**, e é aplicada. Com menos
usuários do que PDFs simultâneos o teste mede o 429, não o Chromium. A
alternativa é desligar o limite na homologação (`RATE_LIMIT_ENABLED=false`).

### Limite de requisições no caminho

O gerador de carga é um único IP. Duas camadas podem responder 429 no lugar da
API, e nesse caso o número medido é o do limite:

- **Nginx** (`ops/nginx/beneficios-api.conf`): 20 req/s por IP, 5 req/s em
  `/api/auth/`. Para medir a API, aponte o `BASE_URL` direto para uma réplica
  (`http://127.0.0.1:3001`) — ou, para medir as duas réplicas com o
  balanceamento, suba o limite do Nginx **da homologação** durante o teste.
- **Aplicação**: limites por usuário, CPF e chassi. Em modo observação eles só
  contam (`rate_limit_hits_total{resultado="observado"}`); os aplicados
  devolvem 429.

Todo roteiro publica o contador `respostas_429`. Se ele não for zero, o
resultado não serve como linha de base.

## O que medir

O resumo do k6 (p95, taxa de erro, `dropped_iterations`) mostra o que o cliente
sentiu. A causa está do lado do servidor — acompanhe durante o teste, pelo
`/metrics` de cada processo:

| O que | Métrica | Sinal de limite |
|---|---|---|
| Atraso do event loop | `nodejs_eventloop_lag_p99_seconds` | acima de 0,2 s: algo síncrono segura o processo; a latência de TODAS as rotas sobe junto |
| Memória | `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes` | subindo sem voltar entre os patamares; perto do `mem_limit` o container é morto (OOM) |
| Memória do Chromium | `docker stats` do serviço `pdf` (o `/metrics` só vê o Node) | perto de 3 GB no degrau de PDFs |
| Pool do Prisma | log da API: erro `P2024` (tempo esgotado esperando conexão); no MySQL, `SHOW STATUS LIKE 'Threads_connected'` | P2024 = pool do processo esgotado (`PRISMA_CONNECTION_LIMIT`), mesmo com o MySQL folgado |
| Latência por rota | `http_request_duration_seconds_bucket` | qual rota puxa o p95 |
| Vendors | `vendor_request_duration_seconds_bucket`, `vendor_requests_total` | o simulador virou o gargalo? |
| Filas | `queue_jobs{state="waiting"}`, `queue_oldest_waiting_age_seconds` | `pdf-render` acumulando = teto do serviço `pdf` |
| CPU | `docker stats` | réplica colada no limite de 1 CPU |

No `dropped_iterations` do `abertura-do-app.js`: se for maior que zero, o
gerador não conseguiu manter a taxa pedida (a API ficou lenta e os VUs
acabaram). A taxa real foi menor do que a configurada.

### Roteiro sugerido para a linha de base

1. `abertura-do-app.js` com `TAXA_ABERTURAS` em 2, 5, 10, 20… até o p95 ou a
   taxa de erro estourar. Anote a última taxa saudável.
2. `polling-posicao.js` com `VUS` em 50, 100, 200, 400… da mesma forma.
3. `pdf-simultaneo.js` uma vez por provedor em uso. O teto é o último degrau
   sem `pdf_504_prazo` nem `pdf_outros_erros`.
4. Repita o 1 com o 3 rodando em paralelo: é a prova de que o PDF, isolado no
   processo `pdf`, não derruba mais a latência da abertura do app.

Registre, para cada rodada: commit da imagem, limites de CPU/memória, valores
de `PRISMA_CONNECTION_LIMIT` e `PDF_CONCORRENCIA`, o resumo do k6 e os picos
das métricas acima.

## Limitações

- O login por iteração (padrão do `abertura-do-app.js`) é o pior caso: o bcrypt
  custa CPU. O caso comum é o token guardado no aparelho —
  `LOGIN_POR_ITERACAO=false`. Meça os dois.
- Os PDFs são pedidos pela rota síncrona, como o app faz. A API espera o job
  por até `PDF_PRAZO_MS` (padrão 120 s) e devolve 504 depois disso.
- Os thresholds são pontos de partida. Ajuste depois da primeira rodada.
