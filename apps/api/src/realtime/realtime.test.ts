import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { makeDeps, uniqueEmail } from "../test/harness.js";
import { createServer } from "../app.js";
import { signAccess } from "../auth/jwt.js";
import type { ClientToServer, ServerToClient } from "./events.js";

type Client = Socket<ServerToClient, ClientToServer>;

// Two API instances, one Redis (shared via the redis adapter + presence hash).
const d1 = makeDeps();
const d2 = { ...makeDeps(), prisma: d1.prisma };
const s1 = createServer(d1);
const s2 = createServer(d2);
const url = (s: typeof s1) => `http://localhost:${(s.server.address() as AddressInfo).port}`;
const clients: Client[] = [];

const ids = { a: "", b: "", stranger: "", board: "", col1: "", col2: "", card: "" };
const token = (userId: string) => signAccess({ userId });

function client(s: typeof s1, auth: string): Client {
  const c: Client = connect(url(s), { auth: { token: auth }, transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  return c;
}

function next<E extends keyof ServerToClient | "connect_error">(c: Client, event: E, ms = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    c.once(event as any, (p: unknown) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

async function joined(s: typeof s1, userId: string) {
  const c = client(s, token(userId));
  const presence = next(c, "presence:update");
  c.emit("join_board", { boardId: ids.board });
  await presence;
  return c;
}

beforeAll(async () => {
  await Promise.all([s1, s2].map((s) => new Promise<void>((r) => s.server.listen(0, r))));
  const { prisma } = d1;
  const mk = () => prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } }).then((u) => u.id);
  [ids.a, ids.b, ids.stranger] = await Promise.all([mk(), mk(), mk()]);
  const board = await prisma.board.create({
    data: { title: "rt", members: { create: [{ userId: ids.a, role: "owner" }, { userId: ids.b, role: "editor" }] } },
  });
  ids.board = board.id;
  ids.col1 = (await prisma.column.create({ data: { boardId: board.id, title: "c1", position: "m" } })).id;
  ids.col2 = (await prisma.column.create({ data: { boardId: board.id, title: "c2", position: "t" } })).id;
  ids.card = (await prisma.card.create({ data: { columnId: ids.col1, title: "card", position: "m" } })).id;
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  await Promise.all([s1.io.close(), s2.io.close()]);
  await d1.prisma.$disconnect();
});

describe("realtime", () => {
  it("refuses a socket with an invalid token", async () => {
    const err = await next(client(s1, "garbage"), "connect_error");
    expect(err.message).toBe("unauthorized");
  });

  it("non-member join_board → error forbidden", async () => {
    const c = client(s1, token(ids.stranger));
    const err = next(c, "error");
    c.emit("join_board", { boardId: ids.board });
    expect(await err).toEqual({ code: "forbidden" });
  });

  it("REST move on instance 1 reaches a client on instance 2 within 500 ms", async () => {
    const a = await joined(s1, ids.a);
    const b = await joined(s2, ids.b);
    const moved = next(b, "card:moved", 500);
    const t0 = Date.now();
    const res = await fetch(`${url(s1)}/cards/${ids.card}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token(ids.a)}` },
      body: JSON.stringify({ columnId: ids.col2 }),
    });
    expect(res.status).toBe(200);
    const evt = await moved;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(evt.card).toMatchObject({ id: ids.card, columnId: ids.col2 });
    expect(evt.by).toBe(ids.a);
    expect(typeof evt.ts).toBe("number");
    a.close();
    b.close();
  });

  it("presence is shared across instances and updated on disconnect", async () => {
    const a = await joined(s1, ids.a);
    const b = client(s2, token(ids.b));
    const both = next(b, "presence:update");
    b.emit("join_board", { boardId: ids.board });
    expect((await both).users.map((u: { id: string }) => u.id).sort()).toEqual([ids.a, ids.b].sort());

    const afterLeave = next(b, "presence:update");
    a.close();
    expect((await afterLeave).users.map((u: { id: string }) => u.id)).toEqual([ids.b]);
    b.close();
  });

  it("cursor flood of 100 msgs/s relays at most 20/s", async () => {
    const a = await joined(s1, ids.a);
    const b = await joined(s2, ids.b);
    let received = 0;
    b.on("cursor", () => received++);
    // 100 messages inside one second: 10 bursts of 10, on wall-clock ticks (OS timers are coarse).
    const t0 = Date.now();
    for (let tick = 0; tick < 10; tick++) {
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + tick * 95 - Date.now())));
      for (let i = 0; i < 10; i++) a.emit("cursor", { x: tick, y: i });
    }
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 200)); // let in-flight messages land
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(20);
  });
});
