# ══════════════════════════════════════════════════════════════════
# Benefícios API — imagem única para os papéis api | worker | pdf | all
#
# O papel é escolhido em tempo de execução pela env APP_ROLE: `all` no
# docker-compose.yml (um container faz tudo) e um papel por serviço no
# docker-compose.escala.yml. O comando é sempre `node dist/main`.
#
# Os dois estágios usam a MESMA base (Debian bookworm slim). Antes o build
# rodava em Alpine (musl) e a produção em Debian (glibc): binários nativos
# (bcrypt, sharp, engines do Prisma) eram resolvidos para plataformas
# diferentes em cada estágio, e o que o build validava não era o que rodava.
#
# Node 24 é a linha LTS vigente (a 20 saiu de suporte).
#
# Migrations NÃO rodam aqui nem em entrypoint: são um passo único antes do
# deploy (`npx prisma migrate deploy` no host ou `docker compose run --rm
# migrate`). Com várias réplicas subindo ao mesmo tempo, migration em
# entrypoint vira corrida.
# ══════════════════════════════════════════════════════════════════
ARG NODE_IMAGE=node:24-bookworm-slim

# ── Estágio 1: build ─────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# O Chromium vem do sistema no estágio de produção; aqui o Puppeteer não
# precisa baixar o dele (economiza ~170 MB e uma dependência de rede).
ENV PUPPETEER_SKIP_DOWNLOAD=true

# O Prisma detecta a versão da libssl para escolher o engine. Na imagem slim
# o openssl não vem instalado e, sem ele, o Prisma avisa e assume openssl-1.1.x.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dependências primeiro: a camada só é refeita quando o lockfile muda.
COPY package.json package-lock.json ./
RUN npm ci

# Prisma Client (tipos usados na compilação).
COPY prisma ./prisma
RUN npx prisma generate

# Compila (nest build -> dist/). O .dockerignore limita o que entra aqui.
COPY . .
RUN npm run build

# ── Estágio 2: produção ──────────────────────────────────────────
FROM ${NODE_IMAGE} AS production

WORKDIR /app

ENV NODE_ENV=production

# Puppeteer usa o Chromium do sistema, sem download próprio.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Sem telemetria do Prisma nem aviso de versão do npm em container de produção.
ENV CHECKPOINT_DISABLE=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Chromium + fontes para os relatórios PDF (mesmo conjunto de fontes de antes,
# para não mudar a diagramação dos PDFs) e openssl para o engine do Prisma.
# Todos os papéis carregam o Chromium porque a imagem é uma só; só o papel
# `pdf` (e o `all`) chega a abri-lo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-freefont-ttf \
        openssl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Só dependências de produção. O pacote `prisma` (CLI) é devOptional no
# lockfile e continua instalado com --omit=dev: é ele que roda o
# `prisma generate` abaixo e o `prisma migrate deploy` do serviço `migrate`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# Schema + migrations (o serviço `migrate` precisa delas) e o client gerado
# contra o node_modules DESTA imagem.
COPY prisma ./prisma
RUN npx prisma generate

# Artefatos do build.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets

# Diretórios graváveis em tempo de execução. Precisam existir e pertencer ao
# usuário `node` ANTES do `USER node`: um volume nomeado vazio herda o dono e
# o conteúdo do diretório da imagem na primeira montagem.
#   uploads/            FileUploadService (subpastas abaixo) + documentos na raiz
#   updates/            releases OTA do expo-updates (EXPO_UPDATES_DIR)
#   webhook/payloads/   payloads de webhook (volume herdado do compose antigo)
# ATENÇÃO: volumes criados pela imagem antiga (que rodava como root) continuam
# com dono root. O serviço `volumes-permissoes` do compose acerta isso: no
# docker-compose.yml ele roda sozinho antes da `api`, a cada `up`; na
# topologia de escala, o ops/deploy.sh o executa a cada deploy.
RUN mkdir -p \
        uploads/profile-photos \
        uploads/workshop-photos \
        uploads/reinspection-photos \
        uploads/reinspection-templates \
        uploads/slider-photos \
        uploads/popup-photos \
        uploads/direct-partners \
        uploads/associado-sorte \
        updates \
        webhook/payloads \
        tmp/pdf \
    && chown -R node:node uploads updates webhook tmp

# Processo sem privilégio de root (uid/gid 1000, já existente na imagem
# oficial). O código da aplicação fica com dono root e somente leitura para
# o processo; só os diretórios acima são graváveis.
#
# Chromium como não-root: o código abre o Puppeteer com
#   --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu
# (src/rastreamento/{m7,softruck,logica}/pdf/*.service.ts). Com --no-sandbox o
# Chromium não precisa de user namespaces nem de CAP_SYS_ADMIN, então roda
# como `node` sem flag extra no container. Em troca, não há sandbox: o HTML
# renderizado tem de continuar sendo só o que a própria API monta.
# Ele precisa de dois lugares graváveis, ambos já atendidos:
#   - HOME (/home/node, existe na imagem oficial): perfil e crashpad;
#   - /tmp: perfil temporário do Puppeteer e, por causa do
#     --disable-dev-shm-usage, também a memória compartilhada (por isso o
#     /dev/shm maior do serviço `pdf` só passa a contar se essa flag sair).
# Se um dia o --no-sandbox for removido do código, o container passa a
# exigir seccomp/capabilities próprios — não basta mexer aqui.
USER node

EXPOSE 3001

# Encerramento em ordem: o Nest (enableShutdownHooks) fecha HTTP, workers e
# conexões ao receber SIGTERM. Use `init: true`/`--init` para o sinal chegar
# ao Node e os processos órfãos do Chromium serem recolhidos.
STOPSIGNAL SIGTERM

# Sonda de processo vivo (não toca em banco nem Redis: reiniciar o container
# não conserta dependência fora). Feita com o próprio Node para não instalar
# curl. O docker-compose.escala.yml troca esta sonda por /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main"]
