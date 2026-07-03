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
COPY --from=build /app/.output ./.output
EXPOSE 3000
USER node
CMD ["node", ".output/server/index.mjs"]
