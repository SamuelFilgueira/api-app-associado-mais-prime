# ── Stage 1: build ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Instala dependências primeiro (cache layer) — pula download do Chrome
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Gera o Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Compila a aplicação
COPY . .
RUN npm run build

# ── Stage 2: production ─────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

ENV NODE_ENV=production

# Instala Chromium e dependências necessárias para o Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configura Puppeteer para usar o Chromium do sistema (sem fazer download)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copia apenas deps de produção — pula download do Chrome
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev

# Copia Prisma schema + client gerado
COPY prisma ./prisma
RUN npx prisma generate

# Copia build
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets

# Cria diretório de uploads
RUN mkdir -p uploads/profile-photos uploads/workshop-photos

EXPOSE 3001

CMD ["node", "dist/main"]
