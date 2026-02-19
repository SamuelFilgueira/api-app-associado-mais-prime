# ── Stage 1: build ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Instala dependências primeiro (cache layer)
COPY package.json package-lock.json ./
RUN npm ci

# Gera o Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Compila a aplicação
COPY . .
RUN npm run build

# ── Stage 2: production ─────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Copia apenas deps de produção
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia Prisma schema + client gerado
COPY prisma ./prisma
RUN npx prisma generate

# Copia build
COPY --from=builder /app/dist ./dist

# Cria diretório de uploads
RUN mkdir -p uploads/profile-photos uploads/workshop-photos

EXPOSE 3001

CMD ["node", "dist/main"]
