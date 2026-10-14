# Build context: repo root.  docker build -f apps/api/Dockerfile -t pulseboard-api .
# argon2 has no musl prebuild, so stages that install it need a C++ toolchain; the runtime image doesn't.
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN npm ci -w apps/api --include-workspace-root=false
COPY apps/api apps/api
RUN npm run build -w apps/api

# `migrate` target: one-off task that applies migrations (has the prisma CLI the runtime image lacks).
FROM build AS migrate
WORKDIR /repo/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]

# Production node_modules only. --ignore-scripts skips the api postinstall (`prisma generate`, a devDependency);
# argon2 is then compiled explicitly and the generated Prisma client is copied from `build`.
FROM node:20-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# --omit=optional too: the lockfile marks prisma/typescript/effect "devOptional" (peers of @prisma/client),
# which --omit=dev alone keeps. The wasm engines are for edge/driver-adapter runtimes; we use the native
# library engine in .prisma/client (verified: test suite passes with them removed).
# OpenTelemetry packages ship build/esm and build/esnext copies for bundlers; Node resolves only build/src.
# Source maps and .d.ts typings are never loaded by node (no --enable-source-maps): dropped everywhere.
# The Anthropic SDK also ships its TypeScript sources and a CJS build beside the ESM one; this ESM app loads only
# the .mjs files (verified: import + client construction work with the rest removed). 18 MB -> 1.5 MB.
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev --omit=optional --ignore-scripts \
 && npm rebuild argon2 \
 && rm -f node_modules/@prisma/client/runtime/*wasm* \
 && rm -rf node_modules/@opentelemetry/*/build/esm node_modules/@opentelemetry/*/build/esnext \
 && rm -rf node_modules/@anthropic-ai/sdk/src \
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && find node_modules/@anthropic-ai/sdk -name '*.js' -exec sh -c 'for f; do [ -f "${f%.js}.mjs" ] && rm "$f"; done' _ {} +

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# The container only runs `node`; package managers are ~20 MB of the 200 MB budget.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules node_modules
COPY --from=build /repo/node_modules/.prisma node_modules/.prisma
COPY apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/health || exit 1
# --import ./dist/otel.js: OpenTelemetry before the app loads; a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
CMD ["node", "--import", "./dist/otel.js", "dist/index.js"]
