# syntax=docker/dockerfile:1

# ── build (full deps; native modules need a toolchain) ───────────────────────
# The node:22-alpine image already bundles Yarn 1.x, so we use it directly.
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

# ── prod deps only (better-sqlite3 / pg recompiled for the runtime) ──────────
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
# libstdc++ is needed by the better-sqlite3 native addon at runtime.
RUN apk add --no-cache libstdc++
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
