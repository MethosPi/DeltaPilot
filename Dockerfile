FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  make \
  g++ \
  python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.scripts.json README.md ./
COPY packages ./packages
COPY apps ./apps
COPY docs ./docs
COPY scripts ./scripts
COPY .dockerignore ./.dockerignore

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  sqlite3 \
  tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app
COPY docker/entrypoint.sh /app/docker/entrypoint.sh

RUN chmod +x /app/docker/entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["dashboard"]
