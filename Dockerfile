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
# `.output` carries nitro's server bundle (CMD below) and self-contained worker entrypoints. The
# same image can therefore run the web app, scheduled refreshes, or the continuous profile worker
# without runtime node_modules, sources, or tsx.
COPY --from=build /app/.output ./.output
EXPOSE 3000
USER node
CMD ["node", ".output/server/index.mjs"]
