import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import request from "supertest";
import * as Y from "yjs";
import { io as connect, type Socket } from "socket.io-client";
import { makeDeps, uniqueEmail } from "../test/harness.js";
import { createServer } from "../app.js";
import { signAccess } from "../auth/jwt.js";
import type { ClientToServer, DocJoinAck, ServerToClient } from "../realtime/events.js";
import { FIELD, loadState, plainText } from "./persistence.js";

type Client = Socket<ServerToClient, ClientToServer>;
type Srv = ReturnType<typeof createServer>;

// Two API instances on one Postgres + one Redis, like production behind a load balancer.
const d1 = makeDeps();
const d2 = { ...makeDeps(), prisma: d1.prisma };
const s1 = createServer(d1);
const s2 = createServer(d2);
const servers: Srv[] = [s1, s2];
const sockets: Client[] = [];
const ids = { owner: "", editor: "", viewer: "", board: "", col: "" };

const url = (s: Srv) => `http://localhost:${(s.server.address() as AddressInfo).port}`;
const newCard = (description = "") =>
  d1.prisma.card.create({ data: { columnId: ids.col, title: "doc", position: "m", description } }).then((c) => c.id);

/** A Yjs client syncing `doc` for `cardId` through server `s` (sync step 1+2, then live updates both ways). */
async function syncClient(s: Srv, userId: string, cardId: string, doc = new Y.Doc()) {
  const socket: Client = connect(url(s), { auth: { token: signAccess({ userId }) }, transports: ["websocket"], forceNew: true, reconnection: false });
  sockets.push(socket);
  socket.on("doc:update", (p) => p.cardId === cardId && Y.applyUpdate(doc, new Uint8Array(p.update), "remote"));
  const onLocal = (update: Uint8Array, origin: unknown) => origin !== "remote" && socket.emit("doc:update", { cardId, update });
  const ack: DocJoinAck = await new Promise((r) => socket.emit("doc:join", { cardId, sv: Y.encodeStateVector(doc) }, r));
  if ("error" in ack) throw new Error(ack.error);
  Y.applyUpdate(doc, new Uint8Array(ack.update), "remote");
  const missing = Y.encodeStateAsUpdate(doc, new Uint8Array(ack.sv));
  if (missing.length > 2) socket.emit("doc:update", { cardId, update: missing }); // our offline edits
  doc.on("update", onLocal);
  return { doc, socket, readOnly: ack.readOnly, close: () => (doc.off("update", onLocal), socket.close()) };
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Fresh doc built only from what Postgres has. */
async function fromDb(cardId: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await loadState(d1, cardId))!);
  return doc;
}

beforeAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.server.listen(0, r))));
  const mk = () => d1.prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } }).then((u) => u.id);
  [ids.owner, ids.editor, ids.viewer] = await Promise.all([mk(), mk(), mk()]);
  const board = await d1.prisma.board.create({
    data: { title: "collab", members: { create: [
      { userId: ids.owner, role: "owner" }, { userId: ids.editor, role: "editor" }, { userId: ids.viewer, role: "viewer" },
    ] } },
  });
  ids.board = board.id;
  ids.col = (await d1.prisma.column.create({ data: { boardId: board.id, title: "c", position: "m" } })).id;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await Promise.all(servers.map((s) => s.io.close()));
  await d1.prisma.$disconnect();
});

describe("collaborative card description", () => {
  it("1,000 random concurrent edits through two instances converge, and Postgres has the same text", async () => {
    const cardId = await newCard();
    const a = await syncClient(s1, ids.owner, cardId);
    const b = await syncClient(s2, ids.editor, cardId);
    const ta = a.doc.getText("t");
    const tb = b.doc.getText("t");
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    for (let i = 0; i < 1000; i++) {
      const t = i % 2 ? ta : tb;
      if (t.length > 0 && rand(3) === 0) t.delete(rand(t.length), 1 + rand(Math.min(3, t.length - rand(t.length) || 1)));
      else t.insert(rand(t.length + 1), String.fromCharCode(97 + rand(26)));
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5)); // interleave with network delivery
    }
    await until(() => ta.toString() === tb.toString() && Buffer.from(Y.encodeStateVector(a.doc)).equals(Buffer.from(Y.encodeStateVector(b.doc))));
    expect(ta.toString().length).toBeGreaterThan(0);

    await Promise.all([s1.collab.flush(), s2.collab.flush()]);
    expect((await fromDb(cardId)).getText("t").toString()).toBe(ta.toString());
    const fresh = await syncClient(s2, ids.editor, cardId);
    expect(fresh.doc.getText("t").toString()).toBe(ta.toString());
    [a, b, fresh].forEach((c) => c.close());
  });

  it("a viewer can read but its updates are dropped", async () => {
    const cardId = await newCard("read me");
    const v = await syncClient(s1, ids.viewer, cardId);
    expect(v.readOnly).toBe(true);
    expect(plainText(v.doc)).toBe("read me");
    const err = new Promise((r) => v.socket.once("error", r));
    v.doc.getXmlFragment(FIELD).insert(0, [new Y.XmlText("vandal")]);
    expect(await err).toEqual({ code: "forbidden" });
    await s1.collab.flush();
    const other = await syncClient(s2, ids.editor, cardId);
    expect(plainText(other.doc)).toBe("read me");
    [v, other].forEach((c) => c.close());
  });

  it("an instance opening a doc gets another instance's unsaved edits", async () => {
    const cardId = await newCard();
    const a = await syncClient(s1, ids.owner, cardId);
    a.doc.getText("t").insert(0, "unsaved");
    await new Promise((r) => setTimeout(r, 100)); // reached s1; its 2 s persist hasn't run
    const b = await syncClient(s2, ids.editor, cardId); // s2 opens from Postgres + the Redis update log
    expect(b.doc.getText("t").toString()).toBe("unsaved");
    [a, b].forEach((c) => c.close());
  });

  it("API restart mid-session: the reconnecting client's edits survive and other clients get them", async () => {
    const cardId = await newCard();
    const s3 = createServer({ ...makeDeps(), prisma: d1.prisma });
    servers.push(s3);
    await new Promise<void>((r) => s3.server.listen(0, r));
    const a = await syncClient(s3, ids.owner, cardId);
    a.doc.getText("t").insert(0, "before restart ");
    await new Promise((r) => setTimeout(r, 100));
    a.close();
    s3.io.close(); // instance gone; whatever it persisted is all Postgres has
    a.doc.getText("t").insert(a.doc.getText("t").length, "edited offline");

    const back = await syncClient(s1, ids.owner, cardId, a.doc); // reconnect to another instance with the same doc
    const other = await syncClient(s2, ids.editor, cardId);
    await until(() => other.doc.getText("t").toString() === "before restart edited offline");
    await Promise.all([s1.collab.flush(), s2.collab.flush()]);
    expect((await fromDb(cardId)).getText("t").toString()).toBe("before restart edited offline");
    [back, other].forEach((c) => c.close());
  });

  it("seeds from the old description, persists the plain-text projection, and then refuses REST description writes", async () => {
    const cardId = await newCard("line one\nline two");
    const a = await syncClient(s1, ids.owner, cardId);
    expect(plainText(a.doc)).toBe("line one\nline two");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("line three")]);
    a.doc.getXmlFragment(FIELD).push([p]);
    await new Promise((r) => setTimeout(r, 100));
    await s1.collab.flush();
    expect((await d1.prisma.card.findUniqueOrThrow({ where: { id: cardId } })).description).toBe("line one\nline two\nline three");

    const auth = `Bearer ${signAccess({ userId: ids.owner })}`;
    const res = await request(s1.server).patch(`/cards/${cardId}`).set("Authorization", auth).send({ description: "overwrite" });
    expect(res.status).toBe(409);
    expect((await request(s1.server).patch(`/cards/${cardId}`).set("Authorization", auth).send({ title: "renamed" })).status).toBe(200);
    a.close();
  });

  it("awareness (carets) reaches the other instance's clients, including from a viewer, and only for joined cards", async () => {
    const cardId = await newCard();
    const a = await syncClient(s1, ids.owner, cardId);
    const v = await syncClient(s2, ids.viewer, cardId);
    const got = new Promise((r) => a.socket.once("doc:awareness", r));
    v.socket.emit("doc:awareness", { cardId: "not-joined", update: new Uint8Array([9]) });
    v.socket.emit("doc:awareness", { cardId, update: new Uint8Array([1, 2, 3]) });
    expect(await got).toEqual({ cardId, update: Buffer.from([1, 2, 3]) });
    [a, v].forEach((c) => c.close());
  });

  it("a non-member cannot join", async () => {
    const stranger = await d1.prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } });
    await expect(syncClient(s1, stranger.id, await newCard())).rejects.toThrow("forbidden");
  });
});
