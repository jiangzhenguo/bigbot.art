# 构建上下文是仓库根目录: docker build -f apps/relay/Dockerfile .
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /opt/bigbotart
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/relay apps/relay
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --frozen-lockfile --filter @bigbotart/relay...
RUN pnpm --filter @bigbotart/relay build
ENV NODE_ENV=production
EXPOSE 80 443
CMD ["node", "apps/relay/dist/cli.js"]
