import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { makeTestApp, uniqueEmail } from "../test/harness.js";
import { signAccess } from "../auth/jwt.js";
import { enqueueDigests } from "./digest.js";

const { app, prisma } = makeTestApp();

// Fake RelayQ: records every request, answers 202 {jobId}.
type Captured = { auth?: string; body: any };
let captured: Captured[] = [];
let relayq: Server;
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c)).on("end", () => resolve(data));
  });

let owner: { id: string; email: string; auth: string };
let editor: { id: string; email: string; auth: string };
let boardId: string;
let cardId: string;

beforeAll(async () => {
  relayq = createServer(async (req, res) => {
    captured.push({ auth: req.headers.authorization, body: JSON.parse(await readBody(req)) });
    res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ jobId: `job-${captured.length}`, status: "queued" }));
  });
  await new Promise<void>((r) => relayq.listen(0, r));

  const mk = async () => {
    const u = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } });
    return { id: u.id, email: u.email, auth: `Bearer ${signAccess({ userId: u.id })}` };
  };
  owner = await mk();
  editor = await mk();
  const board = await prisma.board.create({
    data: { title: "Jobs", members: { create: [{ userId: owner.id, role: "owner" }, { userId: editor.id, role: "editor" }] } },
  });
  boardId = board.id;
  const col = await prisma.column.create({ data: { boardId, title: "c", position: "m" } });
  cardId = (await prisma.card.create({ data: { columnId: col.id, title: "card", position: "m" } })).id;
});

beforeEach(() => {
  captured = [];
  process.env.RELAYQ_URL = `http://localhost:${(relayq.address() as AddressInfo).port}`;
  process.env.RELAYQ_API_KEY = "rq_test";
});

afterAll(async () => {
  relayq.close();
  await prisma.$disconnect();
});

describe("POST /boards/:id/export", () => {
  it("enqueues board.export with the RelayQ payload shape → 202 {jobId}", async () => {
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({ format: "csv" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: "job-1" });
    expect(captured).toEqual([
      {
        auth: "Bearer rq_test",
        body: {
          type: "board.export",
          payload: { boardId, format: "csv", callbackUrl: `http://localhost:4000/boards/${boardId}/export/callback` },
        },
      },
    ]);
  });

  it("RelayQ unreachable → 503, not 500", async () => {
    process.env.RELAYQ_URL = "http://127.0.0.1:1";
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({});
    expect(res.status).toBe(503);
  });

  it("RelayQ 5xx → 503", async () => {
    const down = createServer((_req, res) => res.writeHead(500).end());
    await new Promise<void>((r) => down.listen(0, r));
    process.env.RELAYQ_URL = `http://localhost:${(down.address() as AddressInfo).port}`;
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({});
    down.close();
    expect(res.status).toBe(503);
  });

  it("bad format → 400, nothing enqueued", async () => {
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({ format: "xml" });
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });
});

describe("POST /cards/:id/attachments/presign", () => {
  beforeAll(() => {
    Object.assign(process.env, { S3_BUCKET: "pb-test", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret" });
  });
  const presign = (body: object) =>
    request(app).post(`/cards/${cardId}/attachments/presign`).set("Authorization", editor.auth).send(body);

  it("returns a signed PUT url and key for a PDF", async () => {
    const res = await presign({ filename: "spec v2.pdf", contentType: "application/pdf", size: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(new RegExp(`^attachments/${cardId}/[0-9a-f-]+-spec_v2\\.pdf$`));
    const url = new URL(res.body.url);
    expect(url.hostname).toContain("pb-test");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
  it("rejects application/x-msdownload with 400", async () => {
    expect((await presign({ filename: "x.exe", contentType: "application/x-msdownload", size: 10 })).status).toBe(400);
  });
  it("rejects > 10 MB with 400", async () => {
    expect((await presign({ filename: "big.png", contentType: "image/png", size: 10 * 1024 * 1024 + 1 })).status).toBe(400);
  });
});

describe("nightly digest", () => {
  it("enqueues one email.digest per member about others' activity, with a per-day idempotency key", async () => {
    await prisma.activity.create({ data: { boardId, userId: owner.id, type: "card.moved", data: {} } });
    const now = new Date();
    const jobs = await enqueueDigests(prisma, now);

    const forEditor = captured.find((c) => c.body.payload.to === editor.email);
    expect(forEditor?.body).toMatchObject({
      type: "email.digest",
      idempotencyKey: `digest:${editor.id}:${now.toISOString().slice(0, 10)}`,
      payload: { userName: editor.email.split("@")[0], items: [{ title: expect.stringContaining("Jobs"), url: expect.stringContaining(boardId) }] },
    });
    // The owner did the only activity on this board, so gets no digest about it.
    expect(captured.find((c) => c.body.payload.to === owner.email)).toBeUndefined();
    expect(jobs.length).toBe(captured.length);
  });
});
