#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# Benefícios API — deploy rolling da TOPOLOGIA DE ESCALA (docker compose)
#
# Só para quem usa `docker-compose.escala.yml` (api ×2, worker, pdf). O
# deploy padrão, de container único, continua sendo:
#     docker compose up -d --build api
#
# Uso:
#   ops/deploy.sh <tag>                 imagem = $APP_IMAGE_REPO:<tag>
#   ops/deploy.sh <registry/repo:tag>   referência completa da imagem
#
#   APP_IMAGE_REPO=ghcr.io/dono/repo ops/deploy.sh 3f2c1ab...   (sha do commit)
#
# O que faz, nesta ordem (qualquer falha aborta):
#   1. baixa a imagem (docker pull);
#   2. garante o Redis no ar — SEM recriar o container (ver nota abaixo);
#   3. roda as migrations (serviço one-off `migrate`), antes de trocar código;
#   4. acerta o dono dos volumes para o usuário `node` da imagem;
#   5. atualiza `worker`, depois `pdf`, esperando cada um ficar saudável;
#   6. atualiza `api-1` e espera /health/ready; só então `api-2`.
#
# Se um serviço novo não ficar saudável, o script devolve AQUELE serviço à
# imagem anterior e para: os que ainda não foram tocados continuam na versão
# antiga, atendendo. Os já atualizados ficam na nova.
#
# Durante a janela convivem código antigo e novo sobre o MESMO banco, já
# migrado. Toda migration precisa ser compatível com a versão anterior
# (expandir primeiro; remover coluna/tabela só em um deploy posterior).
#
# Pré-requisitos na VPS:
#   - este repositório com o .env preenchido (REDIS_PASSWORD incluído);
#   - `docker login` no registry, se a imagem for privada;
#   - Nginx com ops/nginx/beneficios-api.conf (upstream 3001 + 3002).
#
# Redis: o script nunca recria o container do Redis. Mudou a configuração
# dele no compose? Aplique à parte, em horário calmo: `docker compose up -d redis`
# (os dados ficam no volume; as filas param por alguns segundos).
#
# PRIMEIRA VEZ nesta topologia, vindo do compose padrão (serviço único `api`):
# não é rolling — exige uma janela curta, porque o container `api` ocupa a
# porta 3001 e o Redis passa a exigir senha.
#   1. instale o site do Nginx novo e recarregue;
#   2. acrescente ao .env as variáveis novas (fim do .env.example);
#   3. docker pull <imagem>                       (adianta o download)
#   4. docker compose down --remove-orphans       (NUNCA com -v: apaga os volumes)
#   5. ops/deploy.sh <tag>
#
# Variáveis opcionais:
#   APP_IMAGE_REPO        repositório da imagem quando o argumento é só a tag
#   TEMPO_LIMITE_SAUDE    segundos de espera por serviço (padrão 180)
#   PAUSA_ENTRE_REPLICAS  segundos entre api-1 e api-2 (padrão 15; mantenha
#                         acima do fail_timeout do upstream do Nginx)
#   SEM_PULL=1            não baixa a imagem (imagem construída localmente)
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

TEMPO_LIMITE_SAUDE="${TEMPO_LIMITE_SAUDE:-180}"
PAUSA_ENTRE_REPLICAS="${PAUSA_ENTRE_REPLICAS:-15}"
SEM_PULL="${SEM_PULL:-0}"
ARQUIVO_TRAVA="${ARQUIVO_TRAVA:-/tmp/beneficios-api-deploy.lock}"
IMAGEM_ROLLBACK="beneficios-api-rollback"

log()    { printf '[deploy %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
erro()   { printf '[deploy %s] ERRO: %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
aborta() { erro "$*"; exit 1; }

uso() {
  cat >&2 <<'EOF'
Uso: ops/deploy.sh <tag | registry/repositorio:tag>

  ops/deploy.sh ghcr.io/dono/repo:<sha>
  APP_IMAGE_REPO=ghcr.io/dono/repo ops/deploy.sh <sha>
EOF
  exit 2
}

[[ $# -eq 1 && -n "${1:-}" ]] || uso
case "$1" in -h|--help) uso ;; esac

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

# Só o arquivo da topologia de escala: ignora COMPOSE_FILE e overrides locais.
COMPOSE=(docker compose -f docker-compose.escala.yml)

# ── Imagem ───────────────────────────────────────────────────────
if [[ "$1" == */* || "$1" == *:* ]]; then
  APP_IMAGE="$1"
else
  [[ -n "${APP_IMAGE_REPO:-}" ]] \
    || aborta "Informe a imagem completa (registry/repositorio:tag) ou defina APP_IMAGE_REPO."
  APP_IMAGE="${APP_IMAGE_REPO}:$1"
fi
# A variável do ambiente vence a do .env na interpolação do compose.
export APP_IMAGE

# ── Funções ──────────────────────────────────────────────────────

# ID do container do serviço (vazio se não existir).
id_container() {
  "${COMPOSE[@]}" ps -aq "$1" 2>/dev/null | head -n 1 || true
}

# Espera o serviço ficar `healthy` (a sonda do compose é /health/ready).
espera_saudavel() {
  local servico="$1" limite="${2:-$TEMPO_LIMITE_SAUDE}"
  local inicio agora cid estado saude
  inicio="$(date +%s)"

  while true; do
    cid="$(id_container "$servico")"
    if [[ -n "$cid" ]]; then
      estado="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo desconhecido)"
      saude="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-sonda{{end}}' "$cid" 2>/dev/null || echo desconhecido)"

      if [[ "$saude" == "healthy" ]]; then
        return 0
      fi
      if [[ "$saude" == "sem-sonda" && "$estado" == "running" ]]; then
        return 0
      fi
      if [[ "$estado" == "exited" || "$estado" == "dead" ]]; then
        erro "$servico terminou (estado: $estado)."
        return 1
      fi
    fi

    agora="$(date +%s)"
    if (( agora - inicio >= limite )); then
      erro "$servico não ficou saudável em ${limite}s (estado: ${estado:-ausente}, sonda: ${saude:-ausente})."
      return 1
    fi
    sleep 3
  done
}

# Confere /health/ready pela porta publicada no host — o caminho do Nginx.
confere_http() {
  local porta="$1" tentativa
  if ! command -v curl >/dev/null 2>&1; then
    log "curl não encontrado; conferência pela porta $porta pulada (vale a sonda do container)."
    return 0
  fi
  for tentativa in 1 2 3 4 5; do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${porta}/health/ready"; then
      return 0
    fi
    sleep 2
  done
  erro "http://127.0.0.1:${porta}/health/ready não respondeu 200."
  return 1
}

# Devolve o serviço à imagem que rodava antes da tentativa.
reverte() {
  local servico="$1" imagem_anterior="$2" porta="${3:-}"

  if [[ -z "$imagem_anterior" ]]; then
    erro "$servico não tinha versão anterior para restaurar; o container fica como está para inspeção."
    return 0
  fi

  log "Restaurando $servico para a imagem anterior ($imagem_anterior)..."
  # Tag local: a referência antiga pode ser uma tag móvel já sobrescrita pelo pull.
  if ! docker tag "$imagem_anterior" "${IMAGEM_ROLLBACK}:${servico}"; then
    erro "Não foi possível marcar a imagem anterior de $servico — intervenção manual necessária."
    return 0
  fi
  if APP_IMAGE="${IMAGEM_ROLLBACK}:${servico}" "${COMPOSE[@]}" up -d --no-deps --no-build "$servico" \
    && espera_saudavel "$servico" \
    && { [[ -z "$porta" ]] || confere_http "$porta"; }; then
    log "$servico restaurado e saudável na versão anterior."
  else
    erro "$servico NÃO voltou a ficar saudável na versão anterior — intervenção manual necessária."
  fi
}

# Troca um serviço pela imagem nova; em falha, restaura e aborta o deploy.
atualiza() {
  local servico="$1" porta="${2:-}"
  local cid imagem_anterior=""

  cid="$(id_container "$servico")"
  if [[ -n "$cid" ]]; then
    imagem_anterior="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  fi

  log "Atualizando $servico..."
  if "${COMPOSE[@]}" up -d --no-deps --no-build "$servico" \
    && espera_saudavel "$servico" \
    && { [[ -z "$porta" ]] || confere_http "$porta"; }; then
    log "$servico saudável na imagem nova."
    return 0
  fi

  erro "$servico não ficou saudável com $APP_IMAGE. Últimas linhas do log:"
  "${COMPOSE[@]}" logs --no-color --tail 40 "$servico" >&2 || true
  reverte "$servico" "$imagem_anterior" "$porta"
  aborta "Deploy interrompido em $servico. Os serviços ainda não atualizados seguem na versão anterior."
}

# ── Pré-checagens ────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || aborta "docker não encontrado."
docker compose version >/dev/null 2>&1 || aborta "plugin 'docker compose' não encontrado."
[[ -f docker-compose.escala.yml ]] || aborta "docker-compose.escala.yml não encontrado em $RAIZ."
[[ -f .env ]] || aborta ".env não encontrado em $RAIZ."

# Um deploy por vez.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ARQUIVO_TRAVA"
  flock -n 9 || aborta "Já existe um deploy em andamento (trava: $ARQUIVO_TRAVA)."
fi

"${COMPOSE[@]}" config -q \
  || aborta "docker-compose.escala.yml inválido ou variável obrigatória ausente no .env (REDIS_PASSWORD?)."

# Container do compose antigo (serviço `api`): ocupa a porta 3001 de api-1.
legado="$(docker ps -aq \
  --filter "label=com.docker.compose.project.working_dir=${RAIZ}" \
  --filter "label=com.docker.compose.service=api" | head -n 1 || true)"
if [[ -n "$legado" ]]; then
  aborta "Há um container do serviço antigo 'api' (${legado}). Esta é a primeira implantação do compose novo: siga os passos de PRIMEIRA IMPLANTAÇÃO no cabeçalho deste script."
fi

log "Imagem: $APP_IMAGE"

# ── 1. Imagem ────────────────────────────────────────────────────
# `docker pull` direto, e não `docker compose pull`: como os serviços têm
# `build:`, o compose trata falha de pull como "construir depois" e segue.
if [[ "$SEM_PULL" != "1" ]]; then
  log "Baixando a imagem..."
  docker pull "$APP_IMAGE" || aborta "Não foi possível baixar $APP_IMAGE."
fi
docker image inspect "$APP_IMAGE" >/dev/null 2>&1 \
  || aborta "Imagem $APP_IMAGE não existe localmente."

# ── 2. Redis ─────────────────────────────────────────────────────
log "Garantindo o Redis no ar (sem recriar)..."
"${COMPOSE[@]}" up -d --no-recreate redis
espera_saudavel redis 60 || aborta "Redis não está saudável; nada foi alterado na aplicação."

# Só avisa: recriar o Redis no meio do deploy pararia as filas.
redis_cid="$(id_container redis)"
redis_hash_atual="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "$redis_cid" 2>/dev/null || true)"
redis_hash_compose="$("${COMPOSE[@]}" config --hash redis 2>/dev/null | awk '{print $2}' || true)"
if [[ -n "$redis_hash_atual" && -n "$redis_hash_compose" && "$redis_hash_atual" != "$redis_hash_compose" ]]; then
  log "AVISO: o Redis em execução foi criado com uma configuração diferente da do compose atual."
  log "AVISO: aplique à parte, em horário calmo: docker compose up -d redis"
fi

# ── 3. Migrations ────────────────────────────────────────────────
log "Aplicando migrations (prisma migrate deploy)..."
"${COMPOSE[@]}" run --rm --no-deps -T migrate \
  || aborta "Migration falhou. Nenhum serviço foi atualizado."

# ── 4. Dono dos volumes ──────────────────────────────────────────
log "Conferindo o dono dos volumes (uploads, updates, webhook)..."
"${COMPOSE[@]}" run --rm --no-deps -T volumes-permissoes \
  || aborta "Não foi possível ajustar o dono dos volumes. Nenhum serviço foi atualizado."

# ── 5. Processos de fundo ────────────────────────────────────────
atualiza worker
atualiza pdf

# ── 6. Réplicas HTTP, uma por vez ────────────────────────────────
atualiza api-1 3001

# O Nginx tirou a 3001 do rodízio enquanto ela reiniciava; esperar o
# fail_timeout para ela voltar antes de derrubar a 3002.
log "Aguardando ${PAUSA_ENTRE_REPLICAS}s para o Nginx voltar a usar api-1..."
sleep "$PAUSA_ENTRE_REPLICAS"

atualiza api-2 3002

log "Deploy concluído: $APP_IMAGE"
"${COMPOSE[@]}" ps
log "Imagens antigas continuam em disco; limpe quando quiser com 'docker image prune'."
