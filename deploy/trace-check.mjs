// Phase 9 check: one board export = one trace across pulseboard-api → relayq-api → relayq-worker → callback.
// Needs: docker compose up api jaeger, RelayQ api + worker exporting to http://localhost:4318.
// node deploy/trace-check.mjs   (exit 0 = pass)
import { randomBytes } from "node:crypto";

const API = process.env.API ?? "http://localhost:4000";
const JAEGER = process.env.JAEGER ?? "http://localhost:16686";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const email = `trace${Date.now()}@check.dev`;
await call("/auth/register", { body: { email, password: "password123" } });
const { accessToken: token } = await call("/auth/login", { body: { email, password: "password123" } });
const board = await call("/boards", { token, body: { title: "trace" } });

// We start the trace ourselves, so we know its id.
const traceId = randomBytes(16).toString("hex");
const { jobId } = await call(`/boards/${board.id}/export`, {
  token, body: { format: "csv" }, headers: { traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` },
});
for (let i = 0; ; i++) {
  if ((await call(`/boards/${board.id}/exports/${jobId}`, { token })).status === "ready") break;
  if (i > 60) throw new Error("export never became ready");
  await sleep(500);
}

const want = ["pulseboard-api", "relayq-api", "relayq-worker"];
for (let i = 0; ; i++) {
  await sleep(2000); // exporters batch
  const res = await fetch(`${JAEGER}/api/traces/${traceId}`);
  const trace = res.ok ? (await res.json()).data?.[0] : undefined;
  const services = new Set(Object.values(trace?.processes ?? {}).map((p) => p.serviceName));
  const callback = trace?.spans.some((s) => trace.processes[s.processID].serviceName === "pulseboard-api" && /export\/callback/.test(s.operationName + JSON.stringify(s.tags)));
  console.log(`trace ${traceId}: services=${[...services].join(",")} spans=${trace?.spans.length ?? 0} callback=${!!callback}`);
  if (want.every((s) => services.has(s)) && callback) {
    console.log(`PASS  ${JAEGER}/trace/${traceId}`);
    break;
  }
  if (i > 10) {
    console.log("FAIL");
    process.exit(1);
  }
}
