import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// CI provides DATABASE_URL (fresh service container); locally we boot a throwaway Postgres 16.
// Both start empty, so a plain (non-destructive) db push is enough.
export default async function setup(project: TestProject) {
  let pg: EmbeddedPostgres | undefined;
  let url = process.env.DATABASE_URL;
  if (!url) {
    const databaseDir = ".pgdata-test";
    rmSync(databaseDir, { recursive: true, force: true });
    pg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "postgres", port: 54329, persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    url = "postgresql://postgres:postgres@localhost:54329/postgres";
  }
  execSync("npx prisma db push --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  project.provide("databaseUrl", url);
  return async () => {
    await pg?.stop();
  };
}
