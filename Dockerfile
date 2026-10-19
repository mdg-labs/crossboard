# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV npm_config_store_dir=/pnpm/store
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Tools for compiling better-sqlite3 when no prebuilt binary exists for the target platform.
FROM base AS native-tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

FROM native-tools AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/query/package.json packages/query/package.json
COPY e2e/package.json e2e/package.json

# Runtime dependencies of the server only, with better-sqlite3 compiled for this platform.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @crossboard/server

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm --filter ./apps/web build \
 && pnpm --filter ./apps/server build

FROM base AS runtime
ENV NODE_ENV=production \
    CROSSBOARD_DATA_DIR=/data \
    PORT=3000
# The server resolves the SPA at ../../web/dist from apps/server/dist, so the
# apps/server and apps/web layout is kept.
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/dist/index.js"]
