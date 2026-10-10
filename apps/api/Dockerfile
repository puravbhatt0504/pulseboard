# Build context: repo root.  docker build -f apps/api/Dockerfile -t pulseboard-api .
FROM node:20-alpine AS build
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

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# --ignore-scripts: postinstall runs `prisma generate`, but the CLI is a devDependency; copy the client instead.
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev --ignore-scripts \
 && npm rebuild argon2 \
 && npm cache clean --force
COPY --from=build /repo/node_modules/.prisma node_modules/.prisma
COPY --from=build /repo/apps/api/dist apps/api/dist
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
