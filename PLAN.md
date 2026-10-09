# PulseBoard — PLAN

Real-time collaborative Kanban board: boards, columns, cards, live cursors and
presence. Built to show a hand-written Node backend, Redis, WebSockets, Docker
and AWS. **This file is the contract.** Each phase ends in a check that can fail.

Resume line this must earn:
> PulseBoard — real-time collaborative Kanban (Node.js, TypeScript, PostgreSQL,
> Redis, Socket.io, Docker, AWS). Sustains 500 concurrent socket connections at
> p95 < 80 ms broadcast latency (k6); horizontally scaled via Redis pub/sub.

---

## Stack (fixed — do not swap without editing this file)

| Layer | Choice |
|---|---|
| Backend | Node.js 20, TypeScript, Express 4 |
| Realtime | Socket.io 4 + `@socket.io/redis-adapter` |
| DB | PostgreSQL 16, Prisma ORM |
| Cache / pub-sub | Redis 7 (`ioredis`) |
| Auth | Hand-rolled JWT: access 15 min + refresh 7 d (httpOnly cookie, rotated), `argon2` hashing |
| Frontend | Next.js (App Router) + React + Tailwind, `@dnd-kit` for drag |
| Uploads | AWS S3 presigned PUT |
| Tests | Vitest + Supertest (API), Playwright (e2e), k6 (load) |
| Infra | Docker Compose (local), AWS ECS Fargate + RDS + ElastiCache (prod), GitHub Actions |
| Jobs | Calls **RelayQ** (`../relayq`) over HTTP for email digests and exports |

## Layout

```
pulseboard/
  apps/api/        Express + Socket.io server
    src/index.ts           boot: http server, io, redis adapter
    src/auth/              jwt.ts, password.ts, routes.ts, middleware.ts
    src/boards/            routes.ts, service.ts
    src/cards/             routes.ts, service.ts, position.ts
    src/realtime/          socket.ts, presence.ts, events.ts
    src/uploads/           s3.ts
    src/jobs/relayq.ts     client for RelayQ
    prisma/schema.prisma
  apps/web/        Next.js frontend
  load/board.k6.js
  docker-compose.yml
  .github/workflows/ci.yml
```

---

## Phase 1 — Auth (`apps/api/src/auth/`)

- `hashPassword(pw) → string` / `verifyPassword(hash, pw) → boolean` (argon2id)
- `signAccess({userId}) → jwt` (15 min), `signRefresh({userId, tokenId}) → jwt` (7 d)
- Routes:
  - `POST /auth/register {email, password}` → `201 {user:{id,email}}`; duplicate email → `409`; password < 8 chars → `400`
  - `POST /auth/login` → `200 {accessToken}` + `Set-Cookie: refresh=...; HttpOnly; SameSite=Strict`; bad creds → `401` (same message for unknown email and wrong password)
  - `POST /auth/refresh` → new access token, **rotates** refresh; reusing an old refresh token → `401` and revokes all that user's refresh tokens (reuse detection)
  - `POST /auth/logout` → revokes current refresh token
- `requireAuth` middleware: missing/expired token → `401`
- Rate limit `/auth/login`: 5 attempts / 15 min / IP via Redis → 6th returns `429`

**Done:** `apps/api/src/auth/auth.test.ts` passes, covering: register 201/409/400, login 200/401, refresh rotation, refresh reuse → 401 + all revoked, 6th login → 429.

## Phase 2 — Boards, columns, cards (REST)

Prisma models: `User`, `Board`, `BoardMember(role: owner|editor|viewer)`, `Column`, `Card`, `RefreshToken`, `Activity`.

- Card ordering uses **fractional string positions** (`src/cards/position.ts`):
  `between(null, null) → "m"`, `between("a","c") → "b"`, `between("a","b") → "an"`. Never renumber siblings on move.
- Routes (all `requireAuth`, membership-checked):
  - `GET /boards` → boards the user is a member of
  - `POST /boards {title}` → creator becomes owner
  - `GET /boards/:id` → board + columns + cards ordered by position; non-member → `404` (not 403, don't leak existence)
  - `POST /boards/:id/columns`, `POST /columns/:id/cards`
  - `PATCH /cards/:id {title?, description?, columnId?, before?, after?}` → moves compute position from neighbours
  - viewer attempting a write → `403`
  - `POST /boards/:id/members {email, role: editor|viewer}` → owner only (`403` otherwise), unknown email `404`, re-invite updates role → `201` *(added in Phase 4: collaboration needs a way to share a board)*
- `GET /boards/:id` cached in Redis key `board:{id}` (60 s TTL), invalidated on any write to that board.

**Done:** `position.test.ts` asserts the three examples above plus 1,000 random inserts stay strictly ordered; `boards.test.ts` asserts non-member 404, viewer write 403, cache hit returns same body and a write invalidates it.

## Phase 3 — Realtime (`src/realtime/`)

- Socket auth: handshake `auth.token` = access JWT; invalid → connection refused.
- Rooms: `board:{id}`; `join_board {boardId}` checks membership, else emits `error {code:"forbidden"}`.
- Server → client events (`events.ts` exports the typed map):
  - `card:created|updated|moved|deleted {card, by}` — emitted after the REST write commits
  - `presence:update {users:[{id,name,color}]}` — on join/leave
  - `cursor {userId, x, y}` — client sends at most 20/s; server drops extra (throttle in `socket.ts`)
- Presence stored in Redis hash `presence:{boardId}` so it is correct across instances; entry removed on disconnect.
- `@socket.io/redis-adapter` so two API instances share rooms.

**Done:** `realtime.test.ts` spins two server instances on one Redis; client A on instance 1 moves a card via REST, client B on instance 2 receives `card:moved` within 500 ms. Unauthenticated socket is refused. Cursor flood of 100 msgs/s results in ≤ 20 relayed/s.

## Phase 4 — Frontend (`apps/web`)

- Pages: `/login`, `/register`, `/boards`, `/boards/[id]`.
- Drag-and-drop with `@dnd-kit`; optimistic move, rolled back if the PATCH fails.
- Live cursors and avatar stack from presence.
- Access token in memory only; silent refresh on 401.

**Done:** Playwright `e2e/collab.spec.ts`: two browser contexts on the same board; A drags a card to another column, B sees it in the new column without reload; B sees A's cursor element.

## Phase 5 — Uploads + RelayQ integration

- `POST /cards/:id/attachments/presign {filename, contentType}` → `{url, key}` (S3 PUT, 5 min, ≤ 10 MB, image/pdf only else `400`).
- `src/jobs/relayq.ts`: `enqueue(type, payload) → {jobId}` via `POST {RELAYQ_URL}/jobs`, header `Authorization: Bearer RELAYQ_API_KEY`.
  - `POST /boards/:id/export` → enqueues `board.export` → `202 {jobId}`
  - nightly digest: enqueues `email.digest` per user with activity in the last 24 h
- RelayQ down → export returns `503`, never 500.

**Done:** test with a mocked RelayQ asserts correct payload and 202; RelayQ unreachable → 503. Presign rejects `application/x-msdownload` with 400.

## Phase 6 — Docker, CI, AWS

- `docker-compose.yml`: `api`, `web`, `postgres`, `redis`; `docker compose up` gives a working app at `localhost:3000`.
- Multi-stage `Dockerfile` for api (final image < 200 MB).
- `.github/workflows/ci.yml`: lint, typecheck, unit tests with Postgres+Redis service containers, Playwright, build images.
- AWS: ECS Fargate (2 api tasks behind ALB with sticky sessions off — adapter handles it), RDS Postgres, ElastiCache Redis, S3, secrets in SSM Parameter Store. Deploy on push to `main`.

**Done:** CI green on `main`; `curl https://<prod>/health` → `200 {"db":"ok","redis":"ok"}`; `docker image ls pulseboard-api` size < 200 MB.

## Phase 7 — Load test (the resume number)

- `load/board.k6.js`: 500 VUs each open a socket, join one of 10 boards, send cursor updates at 10/s, and one card move every 5 s.
- Measure broadcast latency (server timestamp in payload → client receive).

**Done:** k6 run against the 2-task prod deploy reports `p(95) < 80ms` broadcast latency and `< 1%` errors. Paste the summary into `README.md`. If it fails, the resume line changes to the real number — never the other way round.

---

## Out of scope (until a phase needs it)
OAuth providers, GraphQL, mobile app, Kubernetes, billing.

## Status
- [x] Phase 1 Auth
- [x] Phase 2 REST
- [x] Phase 3 Realtime
- [x] Phase 4 Frontend
- [ ] Phase 5 Uploads + RelayQ
- [ ] Phase 6 Docker / CI / AWS
- [ ] Phase 7 Load test
