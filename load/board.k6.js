// Phase 7 load test: VUS sockets across 10 boards, cursor at 10/s, one card move every 5 s per VU.
// Metric `broadcast_latency` = client receive time - server `ts` in card:moved (run k6 on the API host so clocks match).
// Target API needs TRUST_PROXY_HOPS=1: setup logs in hundreds of users, each with its own X-Forwarded-For,
// so the 5-per-15-min login limit stays per user. Usage: k6 run -e BASE=http://localhost:4000 load/board.k6.js
// Prod (behind CloudFront the limit is per real IP): API_PATH=/api and JWT_ACCESS_SECRET set → register only and sign
// access tokens here instead of logging in (infra/lib/load-stack.ts injects the secret; deploy/aws/load-test.ps1).
import http from "k6/http";
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://localhost:4000";
const API = BASE + (__ENV.API_PATH || "");
const SECRET = __ENV.JWT_ACCESS_SECRET;
const VUS = Number(__ENV.VUS || 500);
const BOARDS = 10;
const DURATION_S = Number(__ENV.DURATION_S || 60);

const latency = new Trend("broadcast_latency", true);
const errors = new Rate("errors");

export const options = {
  setupTimeout: "30m",
  scenarios: { board: { executor: "per-vu-iterations", vus: VUS, iterations: 1, maxDuration: `${DURATION_S + 60}s` } },
  thresholds: { broadcast_latency: ["p(95)<80"], errors: ["rate<0.01"] },
};

const json = (token, ip) => ({
  headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});
const ipFor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

// HS256 like jsonwebtoken's signAccess: {sub, iat, exp}.
function signAccess(userId) {
  const b64 = (o) => encoding.b64encode(JSON.stringify(o), "rawurl");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, iat: now, exp: now + 900 })}`;
  return `${unsigned}.${crypto.hmac("sha256", SECRET, unsigned, "base64rawurl")}`;
}

const BATCH = 8; // registrations in flight: argon2 hashing is the setup bottleneck on small API tasks
const creds = (run, i) => ({ email: `load${i}-${run}@example.com`, password: "load-pass-123" });

/** Registers users n ∈ ids (BATCH at a time) → [{email, id, token?}]. Without SECRET, logs each in (local runs). */
function registerAll(run, ids) {
  const out = [];
  for (let k = 0; k < ids.length; k += BATCH) {
    const chunk = ids.slice(k, k + BATCH);
    const res = http.batch(chunk.map((n) => ["POST", `${API}/auth/register`, JSON.stringify(creds(run, n)), json(null, ipFor(n))]));
    res.forEach((r, j) => {
      if (r.status !== 201) throw new Error(`register ${chunk[j]} → ${r.status}`);
      out.push({ email: creds(run, chunk[j]).email, id: r.json("user.id") });
    });
  }
  if (!SECRET) {
    out.forEach((u, j) => {
      const res = http.post(`${API}/auth/login`, JSON.stringify(creds(run, ids[j])), json(null, ipFor(ids[j])));
      if (res.status !== 200) throw new Error(`login ${ids[j]} → ${res.status}`);
      u.token = res.json("accessToken");
    });
  }
  return out;
}
// Signed tokens are minted when used (15 min TTL), not during a setup that can itself take minutes.
const tokenOf = (u) => u.token || signAccess(u.id);

export function setup() {
  const run = Date.now();
  const owners = registerAll(run, [...Array(BOARDS).keys()].map((b) => 100000 + b));
  const boards = owners.map((owner, b) => {
    const t = tokenOf(owner);
    const board = http.post(`${API}/boards`, JSON.stringify({ title: `load ${b}` }), json(t, "10.255.0.1")).json();
    const cols = [0, 1].map((c) =>
      http.post(`${API}/boards/${board.id}/columns`, JSON.stringify({ title: `c${c}` }), json(t, "10.255.0.1")).json("id"));
    const card = http.post(`${API}/columns/${cols[0]}/cards`, JSON.stringify({ title: "hot card" }), json(t, "10.255.0.1")).json("id");
    return { id: board.id, owner, cols, card };
  });
  const users = registerAll(run, [...Array(VUS).keys()]);
  for (let k = 0; k < users.length; k += BATCH) {
    http.batch(users.slice(k, k + BATCH).map((u, j) => {
      const b = boards[(k + j) % BOARDS];
      return ["POST", `${API}/boards/${b.id}/members`, JSON.stringify({ email: u.email, role: "editor" }), json(tokenOf(b.owner), "10.255.0.1")];
    }));
  }
  return { boards, users: users.map((u, i) => ({ id: u.id, token: u.token, board: i % BOARDS })) };
}

export default function (data) {
  const me = data.users[__VU - 1];
  const token = tokenOf(me);
  const board = data.boards[me.board];
  const wsUrl = `${BASE.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
  let moves = 0;
  sleep((__VU - 1) * 0.02); // ramp sockets over ~10 s; a 500-connect burst overflows the accept backlog

  const res = ws.connect(wsUrl, {}, (socket) => {
    socket.on("message", (msg) => {
      if (msg === "2") return socket.send("3"); // engine.io ping → pong
      if (msg.startsWith("0")) return socket.send(`40${JSON.stringify({ token })}`); // open → connect with auth
      if (msg.startsWith("40")) {
        socket.send(`42${JSON.stringify(["join_board", { boardId: board.id }])}`);
        socket.setInterval(() => socket.send(`42${JSON.stringify(["cursor", { x: Math.random() * 1000, y: Math.random() * 800 }])}`), 100);
        socket.setInterval(() => {
          const r = http.patch(`${API}/cards/${board.card}`, JSON.stringify({ columnId: board.cols[moves++ % 2] }), json(token, "10.255.0.2"));
          errors.add(r.status !== 200);
        }, 5000);
        socket.setTimeout(() => socket.close(), DURATION_S * 1000);
        return;
      }
      if (msg.startsWith("44")) errors.add(true); // connect_error
      if (msg.startsWith('42["card:moved"')) latency.add(Date.now() - JSON.parse(msg.slice(2))[1].ts);
      if (msg.startsWith('42["error"')) errors.add(true);
    });
    socket.on("error", () => errors.add(true));
  });
  errors.add(!check(res, { "ws 101": (r) => r && r.status === 101 }));
}
