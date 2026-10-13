import { execSync } from "node:child_process";

/**
 * Throwaway Postgres 16 with pgvector in Docker (embedded-postgres has no `vector` extension).
 * Locally only: CI passes DATABASE_URL to a pgvector service container instead.
 */
export async function startPostgres(port: number) {
  const name = `pulseboard-test-pg-${port}`;
  const sh = (cmd: string) => execSync(cmd, { stdio: "pipe" }).toString();
  sh(`docker rm -f ${name}`); // a container left by a killed run
  sh(`docker run -d --rm --name ${name} -e POSTGRES_PASSWORD=postgres -p ${port}:5432 pgvector/pgvector:pg16`);
  for (let i = 0; ; i++) {
    try {
      // pg_isready says yes during initdb's temporary server, so ask over TCP, which that server doesn't listen on.
      sh(`docker exec ${name} psql -h 127.0.0.1 -U postgres -c "select 1"`);
      break;
    } catch {
      if (i > 120) throw new Error(`${name} did not start`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { url: `postgresql://postgres:postgres@localhost:${port}/postgres`, stop: () => void sh(`docker rm -f ${name}`) };
}
