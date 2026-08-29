# 安装前后端共享依赖；后续 target 复用这一层。
FROM oven/bun:1.3.13 AS deps

WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache

# 构建 Vite 前端产物。
FROM deps AS web-build

COPY VERSION CHANGELOG.md ./
COPY packages/contracts packages/contracts
COPY web web
RUN cd web && bun run build

# Fastify API；Bun 原生运行 TypeScript，迁移任务也复用此 target。
FROM deps AS api

COPY packages/contracts packages/contracts
COPY server server

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
EXPOSE 4000
CMD ["bun", "server/src/api.ts"]

# 运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口。
FROM nginx:1.27-alpine AS web

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
