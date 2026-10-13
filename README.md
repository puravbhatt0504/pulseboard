# PulseBoard

Real-time collaborative Kanban: Express + Prisma + Postgres + Redis + Socket.io API, Next.js web. Plan and status: [PLAN.md](PLAN.md).

Live demo (Render free tier, sleeps when idle): https://pulseboard-fmbj.onrender.com

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
Serve: `docker run -p 8000:8000 -e WEBHOOK_SECRET=... -e RELAYQ_URL=... -e RELAYQ_API_KEY=... pulseboard-ml-eta uvicorn eta.serve:app --host 0.0.0.0`, then set RelayQ's `MODEL_SUBSCRIBERS_ETA=http://<host>:8000/reload`.
