FROM node:24-alpine AS build
RUN npm install -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
# `.output` carries both entrypoints: nitro's server bundle (CMD below) and the self-contained
# monthly-refresh worker bundle that Coolify's scheduled task runs with
# `node .output/worker/monthly-user-refresh.mjs`. Both are bundled, so the runtime image needs no
# node_modules, no sources and no tsx — keeping it a fraction of the build stage's ~460 MB tree.
COPY --from=build /app/.output ./.output
EXPOSE 3000
USER node
CMD ["node", ".output/server/index.mjs"]
