# Render free demo: api + web in one image, one public origin (see PLAN.md, "Free always-on demo").
# Build context: repo root. Render passes service env vars as build args; only NEXT_PUBLIC_* are used here.
FROM node:20-alpine
# argon2 has no musl prebuild
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api -w apps/web --include-workspace-root=false
COPY apps/api apps/api
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_SOCKET_URL=/
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
# Next's standalone output doesn't include static assets; copy them next to its server.
RUN npm run build -w apps/api && npm run build -w apps/web \
 && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
COPY deploy/render/start.mjs deploy/render/start.mjs
ENV NODE_ENV=production
CMD ["node", "deploy/render/start.mjs"]
