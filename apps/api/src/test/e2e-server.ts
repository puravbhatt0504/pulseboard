// Self-contained API for Playwright: throwaway Postgres 16 + pgvector (Docker) + in-process Redis mock, port 4000.
// Not for production — `src/index.ts` is the real entrypoint.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { createServer } from "../app.js";
import { startPostgres } from "./pg.js";

process.env.JWT_ACCESS_SECRET ??= "e2e-access";
process.env.JWT_REFRESH_SECRET ??= "e2e-refresh";
// Each Playwright context sends its own X-Forwarded-For, so the per-IP login limit isn't shared by every test.
process.env.TRUST_PROXY_HOPS ??= "1";

const pg = await startPostgres(54330);
const url = pg.url;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

const { server } = createServer({ prisma: new PrismaClient({ datasourceUrl: url }), redis: new RedisMock() as unknown as Redis });
server.listen(4000, () => console.log("e2e api on :4000"));

const stop = async () => {
  pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
