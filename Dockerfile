FROM node:24-alpine AS build
RUN npm install -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# `.output` carries Nitro's server bundle and the self-contained worker entrypoints. They are
# bundled, so the runtime image needs no node_modules, sources, or tsx.
COPY --from=build /app/.output ./.output
USER node

# Coolify's profile-ingestion application builds this target. Dockerfile applications ignore
# Coolify's start-command override, so the worker needs its own image target and CMD.
FROM runtime AS worker
CMD ["node", ".output/worker/profile-ingestion-worker.mjs"]

# Keep the web image as the final/default target so the existing Coolify application is unchanged.
FROM runtime AS web
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
