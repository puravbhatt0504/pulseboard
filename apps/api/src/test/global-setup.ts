import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import { startPostgres } from "./pg.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// CI provides DATABASE_URL (fresh service container); locally we boot a throwaway Postgres 16 + pgvector.
// Both start empty, so a plain (non-destructive) db push is enough.
export default async function setup(project: TestProject) {
  let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let url = process.env.DATABASE_URL;
  if (!url) {
    pg = await startPostgres(54329);
    url = pg.url;
  }
  execSync("npx prisma db push --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  project.provide("databaseUrl", url);
  return async () => {
    pg?.stop();
  };
}
