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
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev --ignore-scripts && npm rebuild argon2

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules node_modules
COPY --from=build /repo/node_modules/.prisma node_modules/.prisma
COPY apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
