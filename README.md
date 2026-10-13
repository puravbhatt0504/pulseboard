# PulseBoard

Real-time collaborative Kanban: Express + Prisma + Postgres + Redis + Socket.io API, Next.js web. Plan and status: [PLAN.md](PLAN.md).

Live demo (Render free tier, sleeps when idle): https://pulseboard-fmbj.onrender.com

## Tracing

OpenTelemetry in the API (`apps/api/src/otel.ts`, loaded with `node --import`; off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set). A board export is one trace: `pulseboard-api` → `relayq-api` → `relayq-worker` → the signed callback back into `pulseboard-api` (W3C `traceparent` on every hop).

```bash
docker compose up -d api jaeger
```

Then run RelayQ's api and worker with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and check the trace (prints the Jaeger link):

```bash
node deploy/trace-check.mjs
```

## Semantic search + duplicate detection

Cards are embedded (Voyage `voyage-3.5`, 1024 dims) through RelayQ: `embed.batch` when a card's text changes (skipped when the text hash is unchanged), and RelayQ's synchronous `POST /embed` for a search query or the "Looks like…" check while typing a new card. Vectors live in Postgres (pgvector, HNSW). Search fuses vector top 10 and full-text top 10 with Reciprocal Rank Fusion (k = 60), scoped to one board. If embeddings are unavailable, search falls back to full-text only.

Eval data is real: GitHub issues that maintainers closed as "Duplicate of #N" in facebook/react and microsoft/vscode (`node eval/build-datasets.mjs`). That gives 368 labelled pairs (half true duplicates) and 184 search queries (a duplicate's title, expecting its original) over 85 cards.

**These numbers are from the local stand-in embedder (`deploy/voyage-stub.mjs`: hashed words and trigrams), not Voyage.** It sees wording, not meaning, so it favours full-text. Re-run both evals with a real `VOYAGE_API_KEY` and update this table and `DUP_THRESHOLD`.

| `npm run eval:dup` (stand-in) | precision | recall |
|---|---|---|
| threshold 0.85 | 0.892 | 0.315 |
| **threshold 0.90 (chosen: lowest with precision ≥ 0.90)** | **0.963** | **0.141** |
| threshold 0.95 | 1.000 | 0.092 |

| `npm run eval:search` (stand-in) | Recall@5 |
|---|---|
| hybrid (RRF) | 0.853 |
| vector only | 0.793 |
| full-text only | 0.880 |

To run the evals locally, start the stand-in, then RelayQ's API with `VOYAGE_BASE_URL=http://localhost:8099 VOYAGE_API_KEY=stub` (or with a real key and no `VOYAGE_BASE_URL`):

```bash
node deploy/voyage-stub.mjs
```

```bash
npm run eval:dup -w apps/api
```

```bash
npm run eval:search -w apps/api
```

## Load test

`load/board.k6.js`: N users across 10 boards, each with a socket sending cursor updates at 10/s and one card move every 5 s.
`broadcast_latency` = receive time minus the server timestamp on `card:moved`.

Measured 2026-10-13, 60 s, **one API process on a laptop** (embedded Postgres, in-process Redis mock, k6 on the same machine):

| Users | broadcast p95 | broadcast median | card PATCH p95 | errors |
|------:|--------------:|-----------------:|---------------:|-------:|
| 200   | 90 ms         | 1 ms             | 336 ms         | 0%     |
| 500   | 2.35 s        | 2 ms             | 3.16 s         | 0%     |
| 500, batched cursors | **2 ms** | 1 ms         | 45 ms          | 0%     |

The first two rows relayed every cursor move to every other user: 5,000 moves/s, each to 49 people, about 245,000 messages/s, and one process fell behind.
Cursors now go out as one batch per board every 66 ms, holding only each user's latest position. That brought 500 users to a 2 ms broadcast p95 on one laptop process.
The PLAN "Done" check is for a 2-instance production deploy, which hasn't been run.

```
cd apps/api && TRUST_PROXY_HOPS=1 npx tsx src/test/e2e-server.ts   # local target
k6 run -e VUS=500 load/board.k6.js
```

## Card completion-time model (`ml/eta`)

Trainer image `pulseboard-ml-eta` for RelayQ's `ml.retrain` job: `docker build -t pulseboard-ml-eta ml/eta`.
Synthetic data (assumptions in `ml/eta/eta/simulate.py`), time split (train on the oldest 80%, test on the newest 20%), 2026-10-13:

| Model | test MAE |
|---|---:|
| median per board (baseline) | 26.68 h |
| linear regression | 18.99 h |
| XGBoost (p50 quantile) | **16.70 h** |

The p90 prediction covers 91.8% of test cards.

**Real data** (2026-10-13): 1,214 settled GitHub issues from facebook/react and vercel/next.js (`python -m eta.github_import`; opened ≥ 60 days ago, completion time capped at 60 days, a third hit the cap). Same time split:

| Model | test MAE |
|---|---:|
| median per board (baseline) | 501 h |
| linear regression | 601 h |
| XGBoost (p50 quantile) | **380 h** |

The p90 prediction covers 87% of test issues. Errors are large because the data has two humps: the typical issue closes in about 5 h, while a third of them run past 60 days.
Serve: `docker compose --profile ml up eta` (port 8000; reads `ml/eta/models`). In RelayQ set `TRAINER_MODEL_DIR=<this repo>/ml/eta/models` and `MODEL_SUBSCRIBERS_ETA=http://localhost:8000/reload`.
