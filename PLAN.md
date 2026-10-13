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

- `POST /cards/:id/attachments/presign {filename, contentType, size}` → `{url, key}` (S3 PUT, 5 min, ≤ 10 MB, image/pdf only else `400`). *`size` added: a presigned PUT can only cap size if `ContentLength` is signed.*
- `src/jobs/relayq.ts`: `enqueue(type, payload) → {jobId}` via `POST {RELAYQ_URL}/jobs`, header `Authorization: Bearer RELAYQ_API_KEY`.
  - `POST /boards/:id/export` → enqueues `board.export` → `202 {jobId}`
  - nightly digest (`src/jobs/digest-cli.ts`, run by a scheduled task): enqueues `email.digest` per member of a board with *other members'* activity in the last 24 h; idempotency key `digest:{userId}:{UTC date}`
  - RelayQ 4xx (our payload/key is wrong) → `502`
- **RelayQ round trip** (matches `../relayq/src/worker/handlers/board.export.ts`): RelayQ fetches `GET {PULSEBOARD_URL}/boards/:id` with `Authorization: Bearer <PULSEBOARD_TOKEN>`, uploads to S3, then POSTs `{jobId, url}` to `callbackUrl` with `x-relayq-signature` = hex HMAC-SHA256(raw body, `WEBHOOK_SECRET`) and retries until 2xx.
  - Env: `RELAYQ_SERVICE_TOKEN` (= RelayQ's `PULSEBOARD_TOKEN`), `RELAYQ_WEBHOOK_SECRET` (= RelayQ's `WEBHOOK_SECRET`). Unset → service auth and callbacks are rejected.
  - Model `Export {jobId @id, boardId, requestedBy, format, status: queued|ready, url?}`; `POST /boards/:id/export` writes it after RelayQ accepts.
  - `GET /boards/:id` with the service token → `200` board for any id; wrong token → `401`.
  - `POST /boards/:id/export/callback`: bad/missing signature → `401`; unknown job (or job of another board) → `404`; valid → `204`, export `ready` with `url`, socket `export:ready {jobId, url}` to `board:{id}`; the same callback again → `204`, no change (idempotent).
  - `GET /boards/:id/exports/:jobId` (member) → `{jobId, format, status, url}`.
  - Web: Export button (json/csv) → "Exporting…" → download link on `export:ready`.
  - **Done:** `jobs.test.ts` asserts each status above, including a signature computed exactly as RelayQ's `sign()` does.
- RelayQ down → export returns `503`, never 500.

**Done:** test with a mocked RelayQ asserts correct payload and 202; RelayQ unreachable → 503. Presign rejects `application/x-msdownload` with 400.

## Phase 6 — Docker, CI, AWS

- `docker-compose.yml`: `api`, `web`, `postgres`, `redis`; `docker compose up` gives a working app at `localhost:3000`.
- Multi-stage `Dockerfile` for api (final image < 200 MB).
- `.github/workflows/ci.yml`: lint, typecheck, unit tests with Postgres+Redis service containers, Playwright, build images.
- AWS: ECS Fargate (2 api tasks behind ALB with sticky sessions off — adapter handles it), RDS Postgres, ElastiCache Redis, S3, secrets in SSM Parameter Store. Deploy on push to `main`.
- **AWS contract (CDK, TypeScript, `infra/`, account 934846852308, `ap-south-1`):**
  - `infra/bin/app.ts` → two stacks:
    - `PulseboardData`: VPC (2 AZ, public + isolated subnets, **0 NAT**), ECR repos `pulseboard-api` / `pulseboard-web`, RDS Postgres 16 `db.t4g.micro` (isolated, generated password in Secrets Manager), ElastiCache Redis 7 `cache.t4g.micro` (isolated), S3 attachments bucket (private, CORS PUT), GitHub OIDC role trusted only for `repo:puravbhatt0504/pulseboard:ref:refs/heads/main`.
    - `PulseboardApp` (context `imageTag` required): ALB (ingress only from the CloudFront origin-facing prefix list), Fargate `api` ×2 (port 4000, init container runs `prisma migrate deploy`) and `web` ×1 (port 3000), tasks in public subnets with SGs allowing only the ALB; CloudFront in front: `/api/*` + `/socket.io/*` → api, `/*` → web, caching disabled except `/_next/static/*`.
  - Secrets: SSM SecureStrings created out-of-band (CloudFormation can't create SecureStrings): `/pulseboard/jwt-access-secret`, `/pulseboard/jwt-refresh-secret`, `/pulseboard/relayq-api-key` (RelayQ tenant key), `/pulseboard/relayq-service-token` (also set as RelayQ's `PULSEBOARD_TOKEN`), `/pulseboard/relayq-webhook-secret` (= RelayQ's `WEBHOOK_SECRET`). DB password injected from Secrets Manager. `RELAYQ_URL` = RelayQ's Render deployment.
  - App changes: `API_BASE_PATH` (prod `/api`) prefixes every route and the refresh-cookie path; `GET {base}/health`; `DATABASE_URL` composed from `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` when unset; web `NEXT_PUBLIC_API_URL=/api`, `NEXT_PUBLIC_SOCKET_URL=/`.
  - CI `deploy` job (push to `main`, only if repo var `AWS_DEPLOY_ROLE_ARN` is set): OIDC → build + push both images tagged `${{ github.sha }}` → `cdk deploy PulseboardApp -c imageTag=<sha>`.
  - **Checks:** `cd infra && npx cdk synth --strict` exits 0; `apps/api` test: with `API_BASE_PATH=/api`, `GET /api/health` → 200, `GET /health` → 404, login cookie has `Path=/api/auth`. After deploy: `curl https://<cloudfront>/api/health` → `200 {"db":"ok","redis":"ok"}`.

- **Free always-on demo (Render + Neon)** while AWS can't create CloudFront (account unverified). One Render web service, one origin:
  - `deploy/render/Dockerfile` builds api + web into one image; `deploy/render/start.mjs` runs `prisma migrate deploy`, then starts Next (`127.0.0.1:3000`) and the API (`$PORT`), sets `PUBLIC_API_URL=$RENDER_EXTERNAL_URL/api` if unset, and exits if either process exits.
  - API env `WEB_UPSTREAM=http://127.0.0.1:3000`: every path outside `API_BASE_PATH` (`/api`) is proxied there; `/socket.io` stays on the API server. Example: `GET /login` → Next HTML; `GET /api/health` → API JSON.
  - `render.yaml`: web service (free, singapore). Redis = relayq-demo's `relayq-redis` (internal URL, prompted): Render allows one free Key Value per workspace; key spaces don't overlap. `DATABASE_URL` = Neon string (prompted), JWT secrets generated, `RELAYQ_URL=https://relayq-demo.onrender.com`, `RELAYQ_SERVICE_TOKEN` generated, `RELAYQ_API_KEY` / `RELAYQ_WEBHOOK_SECRET` prompted.
  - Uploads without S3 configured → `503` (not `500`).
  - Neon project `summer-feather-59291340` (aws-ap-southeast-1, Postgres 18, Neon's default; the app needs nothing 16-specific) — direct, non-pooled URL.
  - **Checks:** `app.test` style unit test: with `WEB_UPSTREAM` set, `/login` is answered by a fake upstream and `/api/health` by the API; `curl https://<render-url>/api/health` → `200 {"db":"ok","redis":"ok"}`; `/login` returns HTML.

**Done:** CI green on `main`; `curl https://<prod>/health` → `200 {"db":"ok","redis":"ok"}`; `docker image ls pulseboard-api` size < 200 MB.

## Phase 7 — Load test (the resume number)

- `load/board.k6.js`: 500 VUs each open a socket, join one of 10 boards, send cursor updates at 10/s, and one card move every 5 s.
- Measure broadcast latency (server timestamp in payload → client receive).

**Done:** k6 run against the 2-task prod deploy reports `p(95) < 80ms` broadcast latency and `< 1%` errors. Paste the summary into `README.md`. If it fails, the resume line changes to the real number — never the other way round.

## Phase 8 — Conflict-free editing + offline (CRDT) — the "advanced" upgrade

Today two people editing the same card description is last-write-wins: one edit is silently lost. Replace it with a CRDT.

- Card `description` becomes a **Yjs `Y.Text`** document. Titles/positions stay REST (fractional positions already merge cleanly).
- `apps/api/src/collab/`:
  - `yjs-server.ts` — `y-protocols` sync over the existing Socket.io connection, room `card:{id}`; membership-checked like `join_board`. Viewers get read-only (server drops their update messages).
  - `persistence.ts` — store state as `Bytes` in `CardDoc{cardId, state, updatedAt}`; apply incoming updates with `Y.applyUpdate`, debounce-write every 2 s and on last disconnect. Compact (`Y.encodeStateAsUpdate`) when the stored update log exceeds 1 MB.
  - Fan-out across instances through the Redis adapter (updates are binary `Uint8Array`).
- `apps/web`: TipTap editor with `@tiptap/extension-collaboration` + collaboration cursors (names/colors from presence).
- **Offline:** `y-indexeddb` keeps the doc locally; edits made offline sync and merge on reconnect. Board-level REST writes made offline are queued in IndexedDB and replayed in order on reconnect; a replay that now 403/404s is dropped and shown as a toast, not retried forever.
- Search/export still need plain text: on persist, write `Card.descriptionText = ydoc.getText().toString()`.

Examples:
- A types "hello" at 0 and B types "world" at 0 concurrently → both converge to the same string containing both words (order decided by Yjs client IDs), never one lost.
- A goes offline, edits, B edits the same paragraph online; A reconnects → both edits present on both screens within 1 s.

**Done:**
- `collab.test.ts`: two `Y.Doc` clients through two API instances apply 1,000 random concurrent inserts/deletes; final `toString()` is identical on both clients and on a fresh client loading from Postgres.
- Viewer update message → server state unchanged.
- Playwright `e2e/offline.spec.ts`: context A `setOffline(true)`, edits description, B edits same card, A `setOffline(false)` → both texts contain both edits.
- Restart the API mid-session → reconnecting clients lose nothing (state reloaded from `CardDoc`).

## Phase 9 — End-to-end tracing (shared with RelayQ)

- OpenTelemetry Node SDK in `apps/api/src/otel.ts` (loaded before anything else), auto-instrumenting http, express, pg/prisma, ioredis; Socket.io handlers wrapped in manual spans `socket.<event>`.
- `src/jobs/relayq.ts` injects W3C `traceparent` into the RelayQ request; RelayQ continues the trace (its Phase 8).
- Export to an OTLP collector → Jaeger in compose; AWS X-Ray (via ADOT collector) in prod.

**Done:** in compose, `POST /boards/:id/export` produces **one** trace in Jaeger containing spans from `pulseboard-api` → `relayq-api` → `relayq-worker` → the callback back into `pulseboard-api`. Test `otel.test.ts` asserts the outgoing RelayQ request carries a `traceparent` header whose trace-id equals the active span's.

---

# AI phases

Providers (fixed): LLM = Anthropic API (`claude-sonnet-5-5` for answers, `claude-haiku-5-5` for triage); embeddings = Voyage `voyage-3.5` (1024-dim). Vectors in Postgres via **pgvector** — no separate vector DB. All provider calls go through RelayQ job types (`embed.batch`, `llm.complete`, RelayQ Phases 9–10) except the interactive answer stream in Phase 11. Keys only in SSM / `.env`, never in the browser.

## Phase 10 — Semantic search + duplicate detection

- Migration: `CREATE EXTENSION IF NOT EXISTS vector`; `CardEmbedding{cardId PK, embedding vector(1024), contentHash, model, updatedAt}`; HNSW index `vector_cosine_ops`.
- `src/ai/embed.ts`: `cardText(card) → string` = `title + "\n" + descriptionText + "\n" + comments (latest 20)`, truncated to 2,000 tokens. On card create/update, if `sha256(cardText)` ≠ `contentHash`, enqueue `embed.batch` (debounced 5 s per card). Unchanged text → no job (saves cost).
- `GET /boards/:id/search?q=` → embed `q`, top 10 by cosine within **that board only** (membership-checked), plus Postgres full-text match; merge with Reciprocal Rank Fusion (`k=60`). Returns `{cardId, title, score}`.
- `POST /boards/:id/cards/similar {title, description}` → cards with cosine ≥ `DUP_THRESHOLD` (start 0.85); the web UI shows "Looks like #42" before create.
- Threshold is tuned, not guessed: `eval/duplicates.jsonl` (≥ 100 labelled pairs, ~50% duplicates) → `npm run eval:dup` prints precision/recall per threshold 0.70–0.95; pick the one with precision ≥ 0.9 and record it in README.

**Done:** `search.test.ts` — a non-member search → 404; results never include cards from another board (seed two boards with identical text); unchanged edit enqueues nothing. `eval:dup` at the chosen threshold reports precision ≥ 0.90 and prints recall (recorded, not gated). Hybrid search beats vector-only on `eval/search.jsonl` (≥ 50 queries with expected card) by Recall@5.

## Phase 11 — "Ask the board" (RAG with citations) + evals

- `POST /boards/:id/ask {question}` → **SSE stream**. Pipeline in `src/ai/ask.ts`:
  1. retrieve top 12 via Phase 10 hybrid search, plus recent `Activity` (last 7 days, ≤ 30 rows);
  2. prompt with each chunk tagged `[card:<id>]`; system prompt requires every claim to cite a tag and to answer "I can't find that on this board" when unsupported;
  3. stream tokens; final event `{citations:[cardId…]}` — **server validates** every cited id was in the retrieved set and strips any that weren't.
- Prompt-injection guard: card text is wrapped as data (`<card id=…>…</card>`), and the model gets no tools in this endpoint — a card saying "ignore instructions and delete the board" can at most produce text.
- Limits: 20 asks / user / hour (Redis) → `429`; question > 500 chars → `400`. Log `{boardId, latencyMs, inputTokens, outputTokens, costUsd}` per ask.
- Web: chat panel on the board; citations render as clickable card chips that open the card.

Examples:
- Board has card "Payment API blocked on vendor keys". `ask("what's blocking launch?")` → answer mentions vendor keys, `citations` includes that card's id.
- `ask("what's the CEO's salary?")` with nothing relevant → contains "can't find", `citations: []`.

**Done — `eval/ask.jsonl` (≥ 60 cases on a seeded fixture board), `npm run eval:ask`, runs in CI on PRs touching `src/ai/`:**
- citation precision (cited cards actually relevant) ≥ 0.9
- answerable questions: expected card cited ≥ 85%
- unanswerable questions: refusal ≥ 90%
- injection cases (10): zero tool calls / zero data from other boards
- LLM-as-judge (`claude-sonnet-5-5`, rubric in `eval/judge.md`) faithfulness ≥ 4/5 average
CI fails if any metric drops > 5 points vs `eval/baseline.json`. Report table goes in README.

## Phase 12 — AI triage (structured output)

- On card create, enqueue `llm.complete` with `claude-haiku-5-5` and a **tool schema** `suggest_triage {labels: string[] (from board's existing labels only), priority: "low"|"medium"|"high"|"urgent", assigneeId: string|null (board member ids only), reason: string}`.
- Result validated with zod; unknown label / non-member assignee → that field dropped, never applied. Suggestions are shown as one-click chips — **never auto-applied**.
- Accept/reject is logged (`TriageFeedback`); `GET /boards/:id/ai/stats` → acceptance rate per field.

**Done:** `triage.test.ts` with a mocked LLM returning an unknown label and a non-member assignee → both dropped, rest kept. `eval/triage.jsonl` (≥ 80 cards with gold labels/priority) → label F1 and priority accuracy printed and stored in `eval/baseline.json`; priority accuracy beats the "always medium" baseline.

## Phase 13 — Card completion-time predictor (classic ML)

- `ml/eta/` (Python 3.12, its own `pyproject.toml`): features per card — column, label one-hots, description length, #comments, #checklist items, assignee's median past cycle time, board's median, day-of-week created, # cards assignee has open.
- Target: hours from creation to reaching the board's "Done" column. Training data: synthetic generator (`ml/eta/simulate.py`, documented assumptions) + real PulseBoard data once it exists.
- Models compared in `ml/eta/train.py`: median-per-board baseline → linear regression → XGBoost. Time-based split (train on older, test on newest 20%) — no random split leakage.
- Serve: FastAPI `POST /predict {features} → {p50Hours, p90Hours}` (quantile models), Docker image, called by PulseBoard to show "usually done in ~2 days" on cards.
- Retrain weekly as a RelayQ job `ml.retrain`; new model promoted only if test MAE ≤ current; model + metrics versioned in S3 (`models/eta/<date>/`).

**Status (2026-10-13):** `ml/eta` built ahead of order for RelayQ's `ml.retrain`. 8 pytest pass in the image. Test MAE: baseline 26.68 h, linear 18.99 h, XGBoost 16.70 h; p90 covers 91.8%. Real `docker run` trainer path verified (prints the contract JSON line last). The "worse retrain is not promoted" check lives in relayq `test/retrain.test.ts`.
Fixed: RelayQ `TRAINER_MODEL_DIR` mounts a host dir at `/models`, so the model outlives `docker run --rm` (verified: RelayQ `dockerTrainer` → `file:///models/eta/<stamp>/` → `eta` server loads it and `/predict` → `{"p50Hours":10.7,"p90Hours":40.2}`). `docker compose --profile ml up eta` serves on :8000, so locally `MODEL_SUBSCRIBERS_ETA=http://localhost:8000/reload`. Image 759 MB (`xgboost-cpu`). Weekly: `ml/eta/register-retrain-task.ps1` registers Windows task `PulseBoard-ETA-Retrain` (Sundays 15:00, catches up after boot) running `retrain.ps1`. The script starts whatever is down (Docker Desktop, RelayQ postgres/redis, RelayQ API + worker, eta server), queues `ml.retrain`, waits for the job to finish, stops what it started, and logs to `ml/eta/retrain.log`. Exit 1 → the task retries 3×, 30 min apart. Cold-start run verified 2026-10-13 (API and worker were down → started, job completed, v3 rejected, server stayed on v1). Verified live 2026-10-13: v1 promoted (MAE 16.17); a later v2 (16.70) was rejected and the server stayed on v1. Open: hosted retraining needs S3 (`MODEL_BUCKET`), since Render services share no disk. (3) PulseBoard has no labels, comments, checklists or assignees yet, so training is synthetic-only.

**Done:** `pytest ml/eta` passes; `train.py` prints MAE for all three models and XGBoost beats the baseline on the time-split test set (numbers recorded in README); p90 interval covers ≥ 85% of test cases; `/predict` with missing features → 422; a retrain that is worse is not promoted (test with a forced-bad model).

---

## Out of scope (until a phase needs it)
OAuth providers, GraphQL, mobile app, Kubernetes, billing.

## Status
- [x] Phase 1 Auth
- [x] Phase 2 REST
- [x] Phase 3 Realtime
- [x] Phase 4 Frontend
- [x] Phase 5 Uploads + RelayQ
- [ ] Phase 6 Docker / CI / AWS — CI green on main, api image 183 MB, container /health ok; Render demo live at https://pulseboard-fmbj.onrender.com (`/api/health` → `{"db":"ok","redis":"ok"}`, register→login→create board→read board ok, 2026-10-13); **pending: AWS deploy (CloudFront verification)**
- [ ] Phase 7 Load test — `load/board.k6.js` built; local 1-process run with batched cursors (`CURSOR_FLUSH_MS` = 66 in `realtime/socket.ts`): 500 users p95 2 ms, 0% errors (was 2.35 s unbatched; README). **Not done: the check is p95 < 80 ms on the 2-task prod deploy, which does not exist yet.**
- [ ] Phase 8 CRDT editing + offline
- [ ] Phase 9 Tracing
- [ ] Phase 10 Semantic search + duplicates
- [ ] Phase 11 Ask the board (RAG) + evals
- [ ] Phase 12 AI triage
- [ ] Phase 13 Completion-time predictor (ML)
