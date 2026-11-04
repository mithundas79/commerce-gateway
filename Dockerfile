# syntax=docker/dockerfile:1.7
FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 ROLE=api
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
