FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3000 CALLBACK_PORT=3001 STORAGE_DIR=/app/storage FFPROBE_PATH=ffprobe FFMPEG_PATH=ffmpeg
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM base AS development
COPY package.json package-lock.json ./
# Containers use the Compose database and system ffmpeg, not host dev binaries.
RUN npm ci --ignore-scripts
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
EXPOSE 3000 3001 5173
CMD ["node", "node_modules/tsx/dist/cli.mjs", "watch", "src/server/main.ts"]

FROM development AS build
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public/demo ./public/demo
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
EXPOSE 3000 3001
CMD ["node", "dist/server/main.js"]
