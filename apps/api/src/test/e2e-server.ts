// Self-contained API for Playwright: throwaway Postgres 16 + in-process Redis mock, port 4000.
// Not for production — `src/index.ts` is the real entrypoint.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import { PrismaClient } from "@prisma/client";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { createServer } from "../app.js";

process.env.JWT_ACCESS_SECRET ??= "e2e-access";
process.env.JWT_REFRESH_SECRET ??= "e2e-refresh";
// Each Playwright context sends its own X-Forwarded-For, so the per-IP login limit isn't shared by every test.
process.env.TRUST_PROXY_HOPS ??= "1";

const databaseDir = ".pgdata-e2e";
rmSync(databaseDir, { recursive: true, force: true });
const pg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "postgres", port: 54330, persistent: false, onLog: () => {} });
await pg.initialise();
await pg.start();
const url = "postgresql://postgres:postgres@localhost:54330/postgres";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

const { server } = createServer({ prisma: new PrismaClient({ datasourceUrl: url }), redis: new RedisMock() as unknown as Redis });
server.listen(4000, () => console.log("e2e api on :4000"));

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
