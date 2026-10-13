// Render entrypoint: migrate, then run Next (internal) and the API (public $PORT, proxies pages to Next).
// If either process dies the container exits, so Render restarts it rather than serving half an app.
import { execSync, spawn } from "node:child_process";

const env = { ...process.env, API_BASE_PATH: process.env.API_BASE_PATH ?? "/api" };
if (!env.PUBLIC_API_URL && env.RENDER_EXTERNAL_URL) env.PUBLIC_API_URL = `${env.RENDER_EXTERNAL_URL}${env.API_BASE_PATH}`;

execSync("npx prisma migrate deploy", { cwd: "apps/api", stdio: "inherit", env });

const children = [];
function run(name, script, extraEnv, nodeArgs = []) {
  const child = spawn("node", [...nodeArgs, script], { stdio: "inherit", env: { ...env, ...extraEnv } });
  child.on("exit", (code, signal) => {
    console.error(`${name} exited (${code ?? signal})`);
    for (const c of children) c.kill();
    process.exit(code ?? 1);
  });
  children.push(child);
}

run("web", "apps/web/.next/standalone/apps/web/server.js", { PORT: "3000", HOSTNAME: "127.0.0.1" });
run("api", "apps/api/dist/index.js", { WEB_UPSTREAM: "http://127.0.0.1:3000" }, ["--import", "./apps/api/dist/otel.js"]);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
    process.exit(0);
  });
}
