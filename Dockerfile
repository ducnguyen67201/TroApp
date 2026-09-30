FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.server.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
COPY src/server ./src/server
COPY src/contracts ./src/contracts
RUN pnpm db:generate && pnpm build:api && pnpm prune --prod

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_ENV=prod
ENV HOST=0.0.0.0
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
USER node
EXPOSE 3000
CMD ["node", "dist/server/StartApi.js"]
