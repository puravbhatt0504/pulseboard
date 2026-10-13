// Phase 7 load test: VUS sockets across 10 boards, cursor at 10/s, one card move every 5 s per VU.
// Metric `broadcast_latency` = client receive time - server `ts` in card:moved (run k6 on the API host so clocks match).
// Target API needs TRUST_PROXY_HOPS=1: setup logs in hundreds of users, each with its own X-Forwarded-For,
// so the 5-per-15-min login limit stays per user. Usage: k6 run -e BASE=http://localhost:4000 load/board.k6.js
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://localhost:4000";
const VUS = Number(__ENV.VUS || 500);
const BOARDS = 10;
const DURATION_S = Number(__ENV.DURATION_S || 60);

const latency = new Trend("broadcast_latency", true);
const errors = new Rate("errors");

export const options = {
  setupTimeout: "10m",
  scenarios: { board: { executor: "per-vu-iterations", vus: VUS, iterations: 1, maxDuration: `${DURATION_S + 60}s` } },
  thresholds: { broadcast_latency: ["p(95)<80"], errors: ["rate<0.01"] },
};

const json = (token, ip) => ({
  headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});
const ipFor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

function user(i) {
  const email = `load${i}-${Date.now()}@example.com`;
  const body = JSON.stringify({ email, password: "load-pass-123" });
  http.post(`${BASE}/auth/register`, body, json(null, ipFor(i)));
  const res = http.post(`${BASE}/auth/login`, body, json(null, ipFor(i)));
  if (res.status !== 200) throw new Error(`login ${i} → ${res.status}`);
  return { email, token: res.json("accessToken") };
}

export function setup() {
  const boards = [];
  for (let b = 0; b < BOARDS; b++) {
    const owner = user(100000 + b);
    const board = http.post(`${BASE}/boards`, JSON.stringify({ title: `load ${b}` }), json(owner.token, "10.255.0.1")).json();
    const cols = [0, 1].map((c) =>
      http.post(`${BASE}/boards/${board.id}/columns`, JSON.stringify({ title: `c${c}` }), json(owner.token, "10.255.0.1")).json("id"));
    const card = http.post(`${BASE}/columns/${cols[0]}/cards`, JSON.stringify({ title: "hot card" }), json(owner.token, "10.255.0.1")).json("id");
    boards.push({ id: board.id, owner, cols, card });
  }
  const users = [];
  for (let i = 0; i < VUS; i++) {
    const u = user(i);
    const b = boards[i % BOARDS];
    http.post(`${BASE}/boards/${b.id}/members`, JSON.stringify({ email: u.email, role: "editor" }), json(b.owner.token, "10.255.0.1"));
    users.push({ token: u.token, board: i % BOARDS });
  }
  return { boards, users };
}

export default function (data) {
  const me = data.users[__VU - 1];
  const board = data.boards[me.board];
  const wsUrl = `${BASE.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
  let moves = 0;
  sleep((__VU - 1) * 0.02); // ramp sockets over ~10 s; a 500-connect burst overflows the accept backlog

  const res = ws.connect(wsUrl, {}, (socket) => {
    socket.on("message", (msg) => {
      if (msg === "2") return socket.send("3"); // engine.io ping → pong
      if (msg.startsWith("0")) return socket.send(`40${JSON.stringify({ token: me.token })}`); // open → connect with auth
      if (msg.startsWith("40")) {
        socket.send(`42${JSON.stringify(["join_board", { boardId: board.id }])}`);
        socket.setInterval(() => socket.send(`42${JSON.stringify(["cursor", { x: Math.random() * 1000, y: Math.random() * 800 }])}`), 100);
        socket.setInterval(() => {
          const r = http.patch(`${BASE}/cards/${board.card}`, JSON.stringify({ columnId: board.cols[moves++ % 2] }), json(me.token, "10.255.0.2"));
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
