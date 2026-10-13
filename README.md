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

The 80 ms p95 target is **not met** at 500 users on one process. The load is mostly cursor fan-out: 5,000 cursor events/s, each sent to the 49 other users on the board. The PLAN target is for a 2-instance production deploy, which hasn't been run.

```
cd apps/api && TRUST_PROXY_HOPS=1 npx tsx src/test/e2e-server.ts   # local target
k6 run -e VUS=500 load/board.k6.js
```
